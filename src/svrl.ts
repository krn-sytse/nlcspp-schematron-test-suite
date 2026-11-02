import { XMLParser } from 'fast-xml-parser'

// Kept free of the vscode API so it can be exercised from plain node.

const svrlParser = new XMLParser({
	ignoreAttributes: false,
	removeNSPrefix: true,
	isArray: name => name === 'failed-assert' || name === 'successful-report' || name === 'text',
})

export interface SvrlFinding {
	kind: 'failed-assert' | 'successful-report'
	id?: string
	location?: string
	text: string
}

function textOf(value: any): string {
	if (value === undefined || value === null) {
		return ''
	}
	if (typeof value !== 'object') {
		return String(value)
	}
	return String(value['#text'] ?? '')
}

/** Every failed assert and successful report in an SVRL report; an empty list means the document is valid */
export function parseSvrl(svrlXml: string): SvrlFinding[] {
	const output = svrlParser.parse(svrlXml)['schematron-output']
	if (!output) {
		throw new Error('Validator output is not an SVRL report')
	}
	const findings: SvrlFinding[] = []
	for (const kind of ['failed-assert', 'successful-report'] as const) {
		for (const item of output[kind] ?? []) {
			findings.push({
				kind,
				id: item['@_id'],
				location: item['@_location'],
				text: (item.text ?? []).map(textOf).join(' ').replace(/\s+/g, ' ').trim(),
			})
		}
	}
	return findings
}
