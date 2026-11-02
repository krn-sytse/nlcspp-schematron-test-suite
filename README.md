# Schematron Test Suite

Testing tools to easily validate NLCS++ XMLs against Schematron schemas.

## Features

- Validate XMLs for specific NLCS++ versions and matching phases.
- Quickly open the relevant XML file by clicking the test itself.

## Installation

### Extension

1. In the GitHub repository, under [_Actions_ &rarr; _Build VSIX_](https://github.com/krn-sytse/nlcspp-schematron-test-suite/actions/workflows/build-vsix.yaml), select the latest successful build. From the artifacts, download `vsix-package` and unzip the file.
2. In VS Code, under the _Extensions_ tab, click the three dots in the upper-right corner. Select _Install from VSIX..._, then select the unzipped `.vsix` file.

### Java

The validations run on Java (17 or newer), through the `saxon-he.jar` that ships with the validation repository, the same way `scripts/transpile_phases.sh` and `scripts/validate_rules.sh` do. No separate validator download is needed.

If VS Code can't find `java` (`spawn java ENOENT`), set `schematron.javaPath` to the full path of the java executable, or add Java to your `PATH` and restart VS Code completely.

## Requirements

This extension was made specifically for Mijn Aansluiting's [Inhoudelijk-validaties](https://github.com/mijnaansluiting/Inhoudelijke-validaties) repository and expects the following layout:

```
<version>/rules/main.sch                                  # one folder per version in the repository root, e.g. v2026.1.0
<version>/test/rule_validation_data/<rule>/passing/*.xml
<version>/test/rule_validation_data/<rule>/failing/*.xml
```

Every root folder with a `rules/main.sch` is shown as a version; each `<phase>` in that schema becomes a rule. A rule whose pattern is included from another version (e.g. `../../v2026.1.0/rules/patterns/R.4_A.sch`) is marked _inherited_ and uses that version's test data, but is still validated against its own version's `main.sch`, just like `scripts/validate_rules.sh`.

Before validating, each phase is transpiled to `<version>/rules/transpiled_phases/<rule>.xsl` (once per test run), because the `xsl:include` paths in `main.sch` are relative to that folder.

## Extension Settings

This extension contributes the following settings:

* `schematron.saxonJarPath`: Path to the Saxon HE JAR, relative to the workspace root or absolute (default `saxon-he.jar`)
* `schematron.javaPath`: Path to the java executable; empty uses `java` from `PATH` (default empty)
* `schematron.maxConcurrentValidations`: Maximum number of java processes to run concurrently during a test run (default `4`)

## Release Notes

### 0.0.1

- Initial release, allowing you to run basic validation from the test UI.

### 0.0.2

- Added `maxConcurrentValidations` setting, fixing the issue where setting off all tests would spawn hundreds of child processes at once, causing the client's PC to hault.
- Fixed automatic refresh of test interface after modifying test files.
- Updated README.

### 0.0.3

- Support the multiversion repository layout (`<version>/rules/main.sch` in the repository root). The old `validation_schemas/` layouts are no longer supported.
- Inherited rules are resolved to the version their pattern comes from, and run against that version's test data.
- _Run All_ now runs every version (previously nothing ran when no specific test was selected), and excluded tests are respected.
- A test run is now a single run with per-test output and durations, instead of one run per XML file.
- Rules without a `passing` or `failing` folder no longer show up as (crashing) tests.
- The `schematron.jarPath` setting is now actually used.
- Removed versions are now cleared from the test tree on refresh; the refresh button in the Test Explorer works.

### 0.0.4

- Validations now follow the repository's own pipeline: each phase is transpiled with `saxon-he.jar` into `<version>/rules/transpiled_phases/`, and test files are validated against it. This fixes `xsl_functions` being resolved from the old root folder now that they live in the version folders.
- `schxslt-cli.jar` is no longer needed; `schematron.jarPath` is replaced by `schematron.saxonJarPath`.
- Added `schematron.javaPath`, and a clearer error (including the `PATH` the extension sees) when Java can't be found.
- Failed asserts are listed in the test output and in the failure message.
