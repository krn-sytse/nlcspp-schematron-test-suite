# Schematron Test Suite

Testing tools to easily validate NLCS++ XMLs against Schematron schemas.

## Features

- Validate XMLs for specific NLCS++ versions and matching phases.
- Quickly open the relevant XML file by clicking the test itself.

## Installation

### Extension

1. In the GitHub repository, under [_Actions_ &rarr; _Build VSIX_](https://github.com/krn-sytse/nlcspp-schematron-test-suite/actions/workflows/build-vsix.yaml), select the latest successful build. From the artifacts, download `vsix-package` and unzip the file.
2. In VS Code, under the _Extensions_ tab, click the three dots in the upper-right corner. Select _Install from VSIX..._, then select the unzipped `.vsix` file.

### SchXslt CLI

1. Go to the [releases of the `schxslt` Codeberg repository](https://codeberg.org/schxslt/schxslt/releases) and download the `schxslt-cli.jar` file.
2. Copy the file to the root of the desired schematron repository.

## Requirements

This extension was made specifically for Mijn Aansluiting's [Inhoudelijk-validaties](https://github.com/mijnaansluiting/Inhoudelijke-validaties) repository.

## Extension Settings

This extension contributes the following settings:

* `schematron.jarPath`: Relative path to the Schematron validator JAR file 
* `schematron.maxConcurrentValidations`: Maximum number of Schematron validator (java) processes to run concurrently during a test run (default `4`)

## Release Notes

### 0.0.1

- Initial release, allowing you to run basic validation from the test UI.

### 0.0.2

- Added `maxConcurrentValidations` setting, fixing the issue where setting off all tests would spawn hundreds of child processes at once, causing the client's PC to hault.
- Fixed automatic refresh of test interface after modifying test files.
- Updated README.
