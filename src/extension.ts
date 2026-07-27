import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { XMLParser } from 'fast-xml-parser'

const xmlParser = new XMLParser({ ignoreAttributes: false })

const pathBase = vscode.workspace.workspaceFolders?.[0].uri.fsPath as string
const jarPath = path.join(pathBase, 'schxslt-cli.jar')

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

export function activate(context: vscode.ExtensionContext) {

	const testController = vscode.tests.createTestController('schematronTests', 'Schematron Tests')
    context.subscriptions.push(testController)

	testController.createRunProfile(
		'Run Schematron',
		vscode.TestRunProfileKind.Run,
		async (request, token) => {

			const maxConcurrent = vscode.workspace.getConfiguration('schematron')
				.get<number>('maxConcurrentValidations', 4)
			const semaphore = new Semaphore(maxConcurrent)
			const leafTests = (request.include ?? []).flatMap(collectLeafTests)

			await Promise.all(leafTests.map(test =>
				executeLeafTest(test, testController, request, semaphore, token)
			))
		},
		true
	)

	generateTests(testController)

	const templatePathMatch = `${path.join(pathBase, 'test')}/**/*.xml`
	const schemaPathMatch = `${path.join(pathBase, 'validation_schemas', 'base')}/**/*.sch`
	const watcher = vscode.workspace.createFileSystemWatcher(
		`{${templatePathMatch},${schemaPathMatch}}`
	)

	watcher.onDidChange(() => generateTests(testController))
	watcher.onDidCreate(() => generateTests(testController))
	watcher.onDidDelete(() => generateTests(testController))

	console.info("Schematron test suite successfully activated!")
}

function generateTests(testController: vscode.TestController) {
	const schemas: Record<string, any> = {}
	const schemaPath = path.join(pathBase, 'validation_schemas', 'base')

	fs.readdirSync(schemaPath).forEach(schemaFile => {
		const version = path.parse(schemaFile).name
		const xmlContent = fs.readFileSync(path.join(schemaPath, schemaFile), 'utf-8')
		schemas[version] = xmlParser.parse(xmlContent).schema
	})

	for (const [version, schema] of Object.entries(schemas)) {
		const versionSuite = testController.createTestItem(version, version)
		testController.items.add(versionSuite)

		const ruleNames = schema.phase!.map((phase: any) => phase['@_id']) as string[]
		ruleNames.forEach(ruleName => {
			const ruleSuite = testController.createTestItem(ruleName, ruleName)
			versionSuite.children.add(ruleSuite);
			
			['passing', 'failing'].forEach(testType => {
				const testTypeSuite = testController.createTestItem(testType, testType)
				ruleSuite.children.add(testTypeSuite)

				const testDir = path.join(path.join(pathBase, 'test/rule_validation_data', version, ruleName, testType))
				fs.readdirSync(testDir)
					.forEach(testFile => {
						const testFileName = path.parse(testFile).name
						const fileUri = vscode.Uri.file(path.join(testDir, testFile))
						const testItem = testController.createTestItem(testFileName, testFileName, fileUri)
						testTypeSuite.children.add(testItem)
					})
			})
		})
	}
}

export function collectLeafTests(test: vscode.TestItem): vscode.TestItem[] {
	if (test.children.size === 0) {
		return [test]
	}
	const leaves: vscode.TestItem[] = []
	test.children.forEach(child => leaves.push(...collectLeafTests(child)))
	return leaves
}

async function executeLeafTest(
	test: vscode.TestItem,
	testController: vscode.TestController,
	request: vscode.TestRunRequest,
	semaphore: Semaphore,
	token: vscode.CancellationToken
) {
	const name = test.id
	const testType = test.parent!.id
	const rule = test.parent!.parent!.id
	const version = test.parent!.parent!.parent!.id

	const run = testController.createTestRun(request, `${version} ${rule} ${testType} ${name}`)

	const granted = await semaphore.acquire(token)
	if (!granted) {
		run.skipped(test)
		run.end()
		return
	}

	try {
		const schemaPath = path.join(pathBase, 'validation_schemas', 'base', `${version}.sch`)
		const validationOutput = await runSchematronValidator(
			jarPath,
			test.uri!.path,
			schemaPath,
			rule,
			token
		)
		formatValidationOutput(validationOutput, run)

		if (testType === 'passing' && validationOutput.startsWith('[invalid]')) {
			run.failed(test, new vscode.TestMessage('Expected validation to pass, but has failed'))
		}
		else if (testType === 'failing' && validationOutput.startsWith('[valid]')) {
			run.failed(test, new vscode.TestMessage('Expected validation to fail, but has passed'))
		}
		else {
			run.passed(test)
		}
	}
	catch(err: any) {
		if (token.isCancellationRequested) {
			run.skipped(test)
		} else {
			formatValidationOutput(err.message, run)
			run.errored(test, new vscode.TestMessage(err.message))
		}
	}
	finally {
		semaphore.release()
		run.end()
	}
}

function runSchematronValidator(jarPath: string, xmlPath: string, schemaPath: string, phase: string, token: vscode.CancellationToken): Promise<string> {
    return new Promise((resolve, reject) => {
        const java = spawn('java', [
            '-jar', jarPath,
            '-d', xmlPath,
            '-s', schemaPath,
            '-p', phase,
            '-v'
        ])

        const cancelSub = token.onCancellationRequested(() => java.kill())

        let stdout = ''
        let stderr = ''

        java.stdout.on('data', (data) => {
            stdout += data.toString()
        })

        java.stderr.on('data', (data) => {
			stderr += data.toString()
        })

        java.on('error', (err) => {
            cancelSub.dispose()
            reject(err)
        })

        java.on('close', (code) => {
            cancelSub.dispose()
            if (code === 0) {
                resolve(stdout)
            } else {
                reject(new Error(`Validator exited with code ${code}:\n${stderr}`))
            }
        })
    })
}

function formatValidationOutput(validationOutput: string, run: vscode.TestRun) {
	validationOutput.split('\n').forEach(outputLine => {
		outputLine = outputLine.replace('[valid]', '\u001b[32m[valid]\u001b[0m').replace('[invalid]', '\u001b[31m[invalid]\u001b[0m')
		if(outputLine.startsWith('      ')) {
			outputLine = '\u001b[2m' + outputLine + '\u001b[0m'
		}
		run.appendOutput(outputLine + '\r\n')
	})
}