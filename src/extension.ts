import * as vscode from 'vscode'
import * as path from 'path'
import { spawn } from 'child_process'
import { discoverTests, getTranspiledPhasePath, TEST_TYPES, TestType } from './discovery'
import { parseSvrl, SvrlFinding } from './svrl'

const pathBase = vscode.workspace.workspaceFolders?.[0].uri.fsPath as string

export class Semaphore {
	private available: number
	private queue: Array<() => void> = []

	constructor(max: number) { this.available = max }

	async acquire(token: vscode.CancellationToken): Promise<boolean> {
		if (token.isCancellationRequested) {
			return false
		}
		if (this.available > 0) {
			this.available--
			return true
		}
		return new Promise<boolean>(resolve => {
			const grant = () => resolve(true)
			this.queue.push(grant)
			const sub = token.onCancellationRequested(() => {
				const idx = this.queue.indexOf(grant)
				if (idx >= 0) {
					this.queue.splice(idx, 1)
					sub.dispose()
					resolve(false)
				}
			})
		})
	}

	release(): void {
		const next = this.queue.shift()
		if (next) {
			next()
		} else {
			this.available++
		}
	}
}

interface LeafTest {
	version: string
	rule: string
	testType: TestType
	schemaPath: string
	xmlPath: string
}

// Leaf metadata is kept here instead of being derived from the parent chain, so suites without
// test files are never mistaken for tests
const leafTests = new WeakMap<vscode.TestItem, LeafTest>()

export function activate(context: vscode.ExtensionContext) {

	const testController = vscode.tests.createTestController('schematronTests', 'Schematron Tests')
	context.subscriptions.push(testController)

	testController.createRunProfile(
		'Run Schematron',
		vscode.TestRunProfileKind.Run,
		(request, token) => runTests(testController, request, token),
		true
	)

	testController.refreshHandler = async () => generateTests(testController)
	generateTests(testController)

	// Versions live in the workspace root: <version>/rules/main.sch and <version>/test/rule_validation_data/**
	let refreshTimer: NodeJS.Timeout | undefined
	const scheduleRefresh = () => {
		clearTimeout(refreshTimer)
		refreshTimer = setTimeout(() => generateTests(testController), 300)
	}
	const watchers = [
		new vscode.RelativePattern(pathBase, '*/rules/main.sch'),
		new vscode.RelativePattern(pathBase, '*/test/rule_validation_data/**/*.xml'),
	].map(pattern => vscode.workspace.createFileSystemWatcher(pattern))

	watchers.forEach(watcher => {
		watcher.onDidChange(scheduleRefresh)
		watcher.onDidCreate(scheduleRefresh)
		watcher.onDidDelete(scheduleRefresh)
		context.subscriptions.push(watcher)
	})
	context.subscriptions.push({ dispose: () => clearTimeout(refreshTimer) })

	console.info("Schematron test suite successfully activated!")
}

function generateTests(testController: vscode.TestController) {
	let versions
	try {
		versions = discoverTests(pathBase)
	} catch (err: any) {
		vscode.window.showErrorMessage(`Schematron test discovery failed: ${err.message}`)
		return
	}

	const versionSuites = versions.map(({ version, schemaPath, rules }) => {
		const versionSuite = testController.createTestItem(version, version, vscode.Uri.file(schemaPath))

		rules.forEach(({ rule, sourceVersion, tests }) => {
			const ruleSuite = testController.createTestItem(rule, rule)
			if (sourceVersion !== version) {
				ruleSuite.description = `inherited from ${sourceVersion}`
			}
			versionSuite.children.add(ruleSuite)

			TEST_TYPES.forEach(testType => {
				const testTypeSuite = testController.createTestItem(testType, testType)
				ruleSuite.children.add(testTypeSuite)

				tests[testType].forEach(xmlPath => {
					const testName = path.parse(xmlPath).name
					const testItem = testController.createTestItem(testName, testName, vscode.Uri.file(xmlPath))
					leafTests.set(testItem, { version, rule, testType, schemaPath, xmlPath })
					testTypeSuite.children.add(testItem)
				})
			})
		})
		return versionSuite
	})

	// Replace instead of add, so versions that no longer exist are removed from the tree
	testController.items.replace(versionSuites)
}

export function collectLeafTests(test: vscode.TestItem, excluded: ReadonlySet<vscode.TestItem> = new Set()): vscode.TestItem[] {
	if (excluded.has(test)) {
		return []
	}
	if (leafTests.has(test)) {
		return [test]
	}
	const leaves: vscode.TestItem[] = []
	test.children.forEach(child => leaves.push(...collectLeafTests(child, excluded)))
	return leaves
}

interface RunContext {
	run: vscode.TestRun
	semaphore: Semaphore
	token: vscode.CancellationToken
	javaPath: string
	saxonJarPath: string
	/** One transpilation per version/rule per test run, shared by all of that rule's tests */
	transpiled: Map<string, Promise<string>>
}

async function runTests(testController: vscode.TestController, request: vscode.TestRunRequest, token: vscode.CancellationToken) {
	const config = vscode.workspace.getConfiguration('schematron')

	// No include means "run all", across every version
	const roots: vscode.TestItem[] = []
	if (request.include) {
		roots.push(...request.include)
	} else {
		testController.items.forEach(item => roots.push(item))
	}
	const excluded = new Set(request.exclude ?? [])
	const tests = [...new Set(roots.flatMap(root => collectLeafTests(root, excluded)))]

	const ctx: RunContext = {
		run: testController.createTestRun(request),
		semaphore: new Semaphore(config.get<number>('maxConcurrentValidations', 4)),
		token,
		javaPath: config.get<string>('javaPath', '').trim() || 'java',
		saxonJarPath: path.resolve(pathBase, config.get<string>('saxonJarPath', 'saxon-he.jar')),
		transpiled: new Map(),
	}
	tests.forEach(test => ctx.run.enqueued(test))

	try {
		await Promise.all(tests.map(test => executeLeafTest(test, leafTests.get(test)!, ctx)))
	} finally {
		ctx.run.end()
	}
}

/**
 * Same as scripts/transpile_phases.sh. The xsl:include paths in main.sch are relative to
 * <version>/rules/transpiled_phases/, so the phase has to be compiled to that folder before validating.
 */
function transpilePhase(leaf: LeafTest, ctx: RunContext): Promise<string> {
	const key = `${leaf.version}/${leaf.rule}`
	let transpiled = ctx.transpiled.get(key)
	if (!transpiled) {
		transpiled = (async () => {
			const outputPath = getTranspiledPhasePath(pathBase, leaf.version, leaf.rule)
			await withSlot(ctx, () => runJava(ctx, [
				'-jar', ctx.saxonJarPath,
				`-xsl:${path.join(pathBase, 'wrappers', 'transpile_phase_wrapper.xsl')}`,
				`-s:${leaf.schemaPath}`,
				`-o:${outputPath}`,
				`phase=${leaf.rule}`,
			]))
			return outputPath
		})()
		ctx.transpiled.set(key, transpiled)
	}
	return transpiled
}

class Cancelled extends Error {}

async function withSlot<T>(ctx: RunContext, task: () => Promise<T>): Promise<T> {
	if (!await ctx.semaphore.acquire(ctx.token)) {
		throw new Cancelled()
	}
	try {
		return await task()
	} finally {
		ctx.semaphore.release()
	}
}

async function executeLeafTest(test: vscode.TestItem, leaf: LeafTest, ctx: RunContext) {
	const { run, token } = ctx
	try {
		// Transpile first (it takes its own slot), so waiting on it never holds a slot
		const phasePath = await transpilePhase(leaf, ctx).catch(err => {
			throw err instanceof Cancelled ? err : new Error(`Transpiling ${leaf.version} ${leaf.rule} failed: ${err.message}`)
		})

		const { svrl, duration } = await withSlot(ctx, async () => {
			run.started(test)
			const startTime = Date.now()
			const svrl = await runJava(ctx, ['-jar', ctx.saxonJarPath, `-xsl:${phasePath}`, `-s:${leaf.xmlPath}`])
			return { svrl, duration: Date.now() - startTime }
		})

		const findings = parseSvrl(svrl)
		writeOutput(test, leaf, findings, run)

		if (leaf.testType === 'passing' && findings.length > 0) {
			const details = findings.map(f => `- ${f.id ?? f.kind}: ${f.text}`).join('\n')
			run.failed(test, new vscode.TestMessage(`Expected validation to pass, but has failed:\n${details}`), duration)
		}
		else if (leaf.testType === 'failing' && findings.length === 0) {
			run.failed(test, new vscode.TestMessage('Expected validation to fail, but has passed'), duration)
		}
		else {
			run.passed(test, duration)
		}
	}
	catch (err: any) {
		if (err instanceof Cancelled || token.isCancellationRequested) {
			run.skipped(test)
		} else {
			run.appendOutput(`\u001b[31m[error]\u001b[0m ${leaf.version} ${leaf.rule} ${leaf.testType} ${test.label}\r\n${err.message.replace(/\r?\n/g, '\r\n')}\r\n`, undefined, test)
			run.errored(test, new vscode.TestMessage(err.message))
		}
	}
}

function runJava(ctx: RunContext, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const java = spawn(ctx.javaPath, args, { cwd: pathBase })
		const cancelSub = ctx.token.onCancellationRequested(() => java.kill())

		let stdout = ''
		let stderr = ''
		java.stdout.on('data', data => { stdout += data.toString() })
		java.stderr.on('data', data => { stderr += data.toString() })

		java.on('error', (err: NodeJS.ErrnoException) => {
			cancelSub.dispose()
			if (err.code === 'ENOENT') {
				reject(new Error(
					`Could not start Java ("${ctx.javaPath}"): not found. Install Java, or set "schematron.javaPath" to the full path ` +
					`of the java executable (e.g. C:\\Program Files\\Eclipse Adoptium\\jdk-21\\bin\\java.exe) and restart VS Code.\n` +
					`PATH seen by the extension: ${process.env.PATH ?? process.env.Path ?? '(empty)'}`
				))
			} else {
				reject(err)
			}
		})

		java.on('close', code => {
			cancelSub.dispose()
			if (code === 0) {
				resolve(stdout)
			} else {
				reject(new Error(`Saxon exited with code ${code}:\n${stderr.trim()}`))
			}
		})
	})
}

function writeOutput(test: vscode.TestItem, leaf: LeafTest, findings: SvrlFinding[], run: vscode.TestRun) {
	const status = findings.length === 0 ? '\u001b[32m[valid]\u001b[0m' : '\u001b[31m[invalid]\u001b[0m'
	const lines = [`${status} ${leaf.version} ${leaf.rule} ${leaf.testType} ${test.label}`]
	findings.forEach(f => {
		lines.push(`      ${f.id ?? f.kind}: ${f.text}`)
		if (f.location) {
			lines.push(`\u001b[2m        at ${f.location}\u001b[0m`)
		}
	})
	run.appendOutput(lines.join('\r\n') + '\r\n', undefined, test)
}
