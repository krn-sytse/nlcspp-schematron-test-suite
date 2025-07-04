import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { XMLParser } from 'fast-xml-parser'

const config = vscode.workspace.getConfiguration('schematron')
const pathBase = vscode.workspace.workspaceFolders?.[0].uri.fsPath
const jarPath = pathBase + config.get<string>('jarPath')!
const schemaPath = pathBase + config.get<string>('schemaPath')!

export function activate(context: vscode.ExtensionContext) {
	console.log(config)
	console.log(jarPath)
	console.log(schemaPath)
	const schemaXml = fs.readFileSync(schemaPath, 'utf-8')
	const xmlParser = new XMLParser({ ignoreAttributes: false })
	const schemaJson = xmlParser.parse(schemaXml)

	let phases = schemaJson.schema.phase
	phases = Array.isArray(phases) ? phases : [phases]
	phases = phases.map((phase: any) => phase['@_id'])

	let versions = phases.map((phase: string) => {
		const match = phase.match(/^v\d+/)
		return match ? match[0] : null
	}).filter(Boolean)
	versions = [...new Set(versions)]

    const testController = vscode.tests.createTestController('schematronTests', 'Schematron Tests')
    context.subscriptions.push(testController)

	testController.createRunProfile(
		'Run Schematron',
		vscode.TestRunProfileKind.Run,
		async (request, token) => {
			const run = testController.createTestRun(request)

			for (const test of request.include ?? []) {
				const phase = test.id.split('/')[0]
				try {
					const result = await runSchematronValidator(
						jarPath,
						test.uri?.path ?? '',
						schemaPath,
						phase
					)

					result.split('\n').forEach(resultLine => {
						resultLine = resultLine.replace('[valid]', '\u001b[32m[valid]\u001b[0m').replace('[invalid]', '\u001b[31m[invalid]\u001b[0m')
						if(resultLine.startsWith('            ')) {
							resultLine = '\u001b[2m' + resultLine + '\u001b[0m'
						}
						run.appendOutput(resultLine + '\r\n\r\n')
					})
					run.passed(test)
				} catch (err: any) {
					err.message.split('\n').forEach((errLine: string) => {
						if(errLine.trim().startsWith('at')) {
							errLine = '\u001b[2m' + errLine + '\u001b[0m'
						}
						run.appendOutput(errLine + '\r\n')
					})
					run.failed(test, new vscode.TestMessage(err.message))
				}
			}
			run.end()
		},
		true
	)

    const testsDir = vscode.workspace.workspaceFolders?.[0].uri.fsPath + '/source_xmls'
    if (!testsDir) {
        vscode.window.showErrorMessage('No workspace folder found.')
        return
    }

    const loadXmlTests = () => {
		versions.forEach((version: string) => {
			const versionSuite = testController.createTestItem(version, `${version} Tests`)
			testController.items.add(versionSuite)

			const versionDir = `${testsDir}/${version}`
			const files = fs.readdirSync(versionDir)

			const versionPhases = phases.filter((phase: string) => phase.startsWith(version))
			versionPhases.forEach((phase: string) => {
				const phaseSuite = testController.createTestItem(phase, phase)
				versionSuite.children.add(phaseSuite)

				files.forEach(file => {
					if (file.endsWith('.xml')) {
						const fileUri = vscode.Uri.file(path.join(versionDir, file))
						const testItem = testController.createTestItem(`${phase}/${file}`, file, fileUri)
						phaseSuite.children.add(testItem)
					}
				})
			})
		})
    }

    loadXmlTests()
	console.info("Schematron test suite successfully activated!")
}

function runSchematronValidator(jarPath: string, xmlPath: string, schemaPath: string, phase: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const java = spawn('java', [
            '-jar', jarPath,
            '-d', xmlPath,
            '-s', schemaPath,
            '-p', phase,
            '-v'
        ])

        let stdout = ''
        let stderr = ''

        java.stdout.on('data', (data) => {
            stdout += data.toString()
        })
		
        java.stderr.on('data', (data) => {
			stderr += data.toString()
        })

        java.on('close', (code) => {
            if (code === 0) {
                resolve(stdout)
            } else {
                reject(new Error(`Validator exited with code ${code}:\n${stderr}`))
            }
        })
    })
}