# Schematron Test Suite

Testing tools to easily validate NLCS++ XMLs against Schematron schemas.

## Features

- Validate XMLs for specific NLCS++ versions and matching phases.
- Quickly open the relevant XML file by clicking the test itself.

## Requirements

This extension was made specifically for the [nlcspp_inhoudelijke_validaties_temp](https://github.com/krn-nick/nlcspp_inhoudelijke_validaties_temp) repository.

## Extension Settings

This extension contributes the following settings:

* `schematron.jarPath`: Relative path to the Schematron validator JAR file 
* `schematron.schemaPath`: Relative path to the Schematron schema file

## Known Issues

Running tests on version or rule level (e.g., _v10 Tests_, *v11_r1*) will result fail the test instead of running its child tests.

## Release Notes

### 0.0.1

- Initial release, allowing you to run basic validation from the test UI.

