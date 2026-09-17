# BNW SDKs

Public release repository for Flutterwave Beam client SDKs and shared public
libraries.

This repository contains release snapshots that external and internal producer
teams can install without access to the private product repositories where the
SDKs are developed. Source development, private conformance fixtures, service
code, deployment configuration, and private repository history stay in the
owning product repository.

## Current packages

| Package | Public path | Release tag | Primary install |
|---|---|---|---|
| Auditlog Go SDK | `auditlog-go/` | `auditlog-go/vX.Y.Z` | Go module |
| Auditlog JavaScript SDK | `auditlog-js/` | `auditlog-js-vX.Y.Z` | GitHub Release tarball |

The package directories appear after their first public release is exported.
Until then, the install commands below are templates.

## Install the Auditlog Go SDK

Use the Go module path and pin an exact release version:

```sh
go get github.com/flw-beam/bnw-sdks/auditlog-go@vX.Y.Z
```

Import it from Go code:

```go
import audit "github.com/flw-beam/bnw-sdks/auditlog-go"
```

Go release tags are scoped to the module directory:

```text
auditlog-go/vX.Y.Z
```

## Install the Auditlog JavaScript SDK

For npm consumers, install the release tarball attached to the GitHub Release:

```sh
npm install 'https://github.com/flw-beam/bnw-sdks/releases/download/auditlog-js-vX.Y.Z/auditlog-js-X.Y.Z.tgz'
```

For pnpm consumers that want the tagged source package, install from the
repository tag and package path:

```sh
pnpm add 'github:flw-beam/bnw-sdks#auditlog-js-vX.Y.Z&path:auditlog-js'
```

The quotes matter because `&` has shell meaning.

The JavaScript package name remains:

```text
@flutterwavego/audit-service-sdk
```

It is installed from GitHub, not from the public npm registry.

## Runtime configuration

SDK versions do not select staging or production. Pin one package version,
test that version against staging, and promote the same pinned version to
production.

The consuming application chooses the Audit Service environment through its own
runtime configuration:

- Audit Service base URL
- Audit Service API key
- timeout, retry, and application outbox settings where applicable

Never commit API keys or service credentials into this repository.

## Release provenance

Each exported package snapshot includes release metadata recording:

- package name;
- package version;
- public release tag;
- private source repository; and
- private source commit.

This provenance lets maintainers trace a public release back to the exact
reviewed source commit without exposing the private repository history.

## Maintainer workflow

Do not develop SDK changes directly in this repository. Make SDK source changes
in the owning private product repository, run the SDK tests there, and use that
repository's release task to export a reviewed snapshot here.

For the Audit Service SDKs, run from `audit-service-api`:

```sh
task sdk:release SDK=go VERSION=X.Y.Z
task sdk:release SDK=js VERSION=X.Y.Z
```

The release task writes into this repository, validates the public package, and
can optionally commit, tag, and push when called with the relevant flags:

```sh
task sdk:release SDK=go VERSION=X.Y.Z -- --commit
task sdk:release SDK=go VERSION=X.Y.Z -- --tag
task sdk:release SDK=go VERSION=X.Y.Z -- --push
```

For JavaScript releases, attach the generated `auditlog-js-X.Y.Z.tgz` file to
the matching GitHub Release before announcing the version to consumers.

Published tags and release assets are immutable. If a release is wrong, publish
a new version instead of moving an existing tag.
