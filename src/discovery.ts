import * as fs from 'fs'
import * as path from 'path'
import { XMLParser } from 'fast-xml-parser'

// Kept free of the vscode API so it can be exercised from plain node.

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true })

export const TEST_TYPES = ['passing', 'failing'] as const
export type TestType = typeof TEST_TYPES[number]

export interface RuleTests {
	rule: string
	/** Version folder the rule's pattern (and therefore its test data) comes from; differs from the schema version for inherited rules */
	sourceVersion: string
	tests: Record<TestType, string[]>
}

export interface VersionTests {
	version: string
	schemaPath: string
	rules: RuleTests[]
}

export function getSchemaPath(root: string, version: string): string {
	return path.join(root, version, 'rules', 'main.sch')
}

/** Where scripts/transpile_phases.sh puts a compiled phase; main.sch's xsl:include paths are relative to this folder */
export function getTranspiledPhasePath(root: string, version: string, rule: string): string {
	return path.join(root, version, 'rules', 'transpiled_phases', `${rule}.xsl`)
}

export function getTestDataDir(root: string, sourceVersion: string, rule: string, testType: TestType): string {
	return path.join(root, sourceVersion, 'test', 'rule_validation_data', rule, testType)
}

/**
 * Every folder in the workspace root with a rules/main.sch is a version (v2026.1.0, v9999.1.0, ...).
 * Other root folders (configuration, xsl_functions, test, ...) are skipped.
 */
export function discoverVersions(root: string): string[] {
	if (!fs.existsSync(root)) {
		return []
	}
	return fs.readdirSync(root, { withFileTypes: true })
		.filter(entry => entry.isDirectory() && fs.existsSync(getSchemaPath(root, entry.name)))
		.map(entry => entry.name)
		.sort(compareVersions)
}

export function compareVersions(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true })
}

function asArray<T>(value: T | T[] | undefined): T[] {
	if (value === undefined) {
		return []
	}
	return Array.isArray(value) ? value : [value]
}

/**
 * Maps each phase in main.sch to the version folder its pattern is included from, mirroring
 * `scripts/versions.sh rules`: `patterns/R.7.sch` belongs to the version itself,
 * `../../v2026.1.0/rules/patterns/R.4_A.sch` is inherited from v2026.1.0.
 */
export function parseSchema(schemaXml: string, version: string): { rule: string, sourceVersion: string }[] {
	const schema = xmlParser.parse(schemaXml).schema ?? {}
	const includes = asArray<any>(schema.include)
		.map(include => include['@_href'] as string | undefined)
		.filter((href): href is string => !!href)

	return asArray<any>(schema.phase)
		.map(phase => phase['@_id'] as string | undefined)
		.filter((rule): rule is string => !!rule)
		.map(rule => ({ rule, sourceVersion: resolveSourceVersion(rule, includes) ?? version }))
}

function resolveSourceVersion(rule: string, includes: string[]): string | undefined {
	const escapedRule = rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
	// R.4 matches R.4.sch and R.4_A.sch, not R.40.sch
	const patternInclude = new RegExp(`^(?:\\.\\./\\.\\./([^/]+)/rules/)?patterns/${escapedRule}(?:_[^/]*)?\\.sch$`)
	for (const href of includes) {
		const match = patternInclude.exec(href)
		if (match) {
			return match[1]
		}
	}
	return undefined
}

function listTestFiles(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return []
	}
	return fs.readdirSync(dir, { withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.xml'))
		.map(entry => path.join(dir, entry.name))
		.sort((a, b) => compareVersions(path.basename(a), path.basename(b)))
}

export function discoverTests(root: string): VersionTests[] {
	return discoverVersions(root).map(version => {
		const schemaPath = getSchemaPath(root, version)
		const rules = parseSchema(fs.readFileSync(schemaPath, 'utf-8'), version)
			.map(({ rule, sourceVersion }) => ({
				rule,
				sourceVersion,
				tests: {
					passing: listTestFiles(getTestDataDir(root, sourceVersion, rule, 'passing')),
					failing: listTestFiles(getTestDataDir(root, sourceVersion, rule, 'failing')),
				},
			}))
		return { version, schemaPath, rules }
	})
}
