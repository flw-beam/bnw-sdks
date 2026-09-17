# BNW SDKs

Public release repository for Flutterwave Beam client SDKs and shared public
libraries.

SDKs are developed in their owning private product repositories. The `main`
branch of this repository contains documentation only. Existing public tags
record historical SDK snapshots; they do not make this repository a second
development codebase.

## Current packages

| Package | Public path | Release tag | Primary install |
|---|---|---|---|
| Auditlog Go SDK | `auditlog-go/` | `auditlog-go/vX.Y.Z` | Go module |
| Auditlog JavaScript SDK | `auditlog-js/` | `auditlog-js-vX.Y.Z` | GitHub Release tarball |

The `auditlog-go/` and `auditlog-js/` directories are present in the existing
`v0.1.2` tags, not on `main`. Future release publishing is being revised.

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

For npm consumers, a release tarball can be installed from a GitHub Release
once that release and its asset have been published. There is currently no
GitHub Release for the existing JavaScript tag, so this is a future template:

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

Develop SDK changes in the owning private product repository. The earlier
snapshot exporter has been reverted. A replacement release workflow has not
been published yet; do not use the old release task to publish to this repo.

Published tags and release assets are immutable. If a release is wrong, publish
a new version instead of moving an existing tag.
