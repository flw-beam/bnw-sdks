# BNW SDKs

Public release repository for Flutterwave Beam client SDKs and shared public
libraries.

SDKs are developed in their owning private product repositories. The `main`
branch of this repository contains documentation only. Existing public tags
record historical SDK snapshots; they do not make this repository a second
development codebase.

## Contents

- [Current packages](#current-packages)
- Install
  - [Auditlog Go SDK](#install-the-auditlog-go-sdk)
  - [Auditlog JavaScript SDK](#install-the-auditlog-javascript-sdk)
  - [Checkout JavaScript packages](#install-the-checkout-javascript-packages)
  - [Checkout Python SDK](#install-the-checkout-python-sdk)
- [Runtime configuration](#runtime-configuration)
- [Release provenance](#release-provenance)
- [Maintainer workflow](#maintainer-workflow)

## Current packages

| Package | Public path | Release tag | Primary install |
|---|---|---|---|
| Auditlog Go SDK | `auditlog-go/` | `auditlog-go/vX.Y.Z` | Go module |
| Auditlog JavaScript SDK | `auditlog-js/` | `auditlog-js-vX.Y.Z` | GitHub Release tarball |
| Checkout JavaScript SDK | `checkout-sdk/` | `checkout-sdk-vX.Y.Z` | GitHub Release tarball |
| Checkout React bindings | `checkout-react/` | `checkout-react-vX.Y.Z` | GitHub Release tarball |
| Checkout Vue bindings | `checkout-vue/` | `checkout-vue-vX.Y.Z` | GitHub Release tarball |
| Checkout browser runtime | `checkout-runtime/` | `checkout-runtime-vX.Y.Z` | GitHub Release tarball |
| Checkout contract types | `checkout-contracts/` | `checkout-contracts-vX.Y.Z` | GitHub Release tarball |
| Checkout protocol adapters | `checkout-adapters/` | `checkout-adapters-vX.Y.Z` | GitHub Release tarball |
| Checkout CLI | `checkout-cli/` | `checkout-cli-vX.Y.Z` | GitHub Release tarball |
| Checkout Python SDK | `checkout-python/` | `checkout-python-vX.Y.Z` | GitHub Release wheel |

The `auditlog-go/` and `auditlog-js/` directories are present in the existing
`v0.1.2` tags, not on `main`. No Checkout package has a public tag yet; its
rows record the path and tag its first release will use. Each product publishes
its own releases; see [Maintainer workflow](#maintainer-workflow).

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
npm install 'https://github.com/flw-beam/bnw-sdks/releases/download/auditlog-js-vX.Y.Z/flutterwavego-audit-service-sdk-X.Y.Z.tgz'
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

## Install the Checkout JavaScript packages

The Checkout packages share the `@flutterwavego` scope with the Auditlog
JavaScript SDK and are installed from GitHub, not from the public npm registry.
Each public path is the package name without the scope, and each release asset
keeps the file name `pnpm pack` gives it, so `@flutterwavego/checkout-sdk`
ships as `flutterwavego-checkout-sdk-X.Y.Z.tgz` on the `checkout-sdk-vX.Y.Z`
release.

A package that depends on other Checkout packages names each one by its
release tarball URL, so every tarball installs on its own: the package manager
fetches the Checkout packages it needs from their releases and never looks one
up on a registry. The React and Vue bindings expect the application to provide
`react` 18+ or `vue` 3.3+.

There is no GitHub Release for any Checkout package yet, so the commands below
are future templates.

Install each package you use by its release URL, pinned to an exact version:

```sh
npm install 'https://github.com/flw-beam/bnw-sdks/releases/download/checkout-react-vX.Y.Z/flutterwavego-checkout-react-X.Y.Z.tgz'
```

The same URL works with `pnpm add` and `yarn add`. For the CLI, install it
globally:

```sh
npm install -g 'https://github.com/flw-beam/bnw-sdks/releases/download/checkout-cli-vX.Y.Z/flutterwavego-checkout-cli-X.Y.Z.tgz'
```

When an application installs more than one Checkout package, take them from
the same version, so they share one copy of each dependency.

## Install the Checkout Python SDK

The Python SDK is released as a wheel. Install it by URL and pin an exact
release version. This is also a future template:

```sh
pip install 'https://github.com/flw-beam/bnw-sdks/releases/download/checkout-python-vX.Y.Z/flw_checkout-X.Y.Z-py3-none-any.whl'
```

In a requirements file, name the distribution with the same URL:

```text
flw-checkout @ https://github.com/flw-beam/bnw-sdks/releases/download/checkout-python-vX.Y.Z/flw_checkout-X.Y.Z-py3-none-any.whl
```

The wheel keeps its standard file name because pip reads the package name and
version from it. The distribution is `flw-checkout`, imported as
`flw_checkout`, and requires Python 3.9 or later. It is installed from GitHub,
not from PyPI.

## Runtime configuration

SDK versions do not select staging or production. Pin one package version,
test that version against staging, and promote the same pinned version to
production.

The consuming application chooses the environment through its own runtime
configuration.

For the Audit Service:

- Audit Service base URL
- Audit Service API key
- timeout, retry, and application outbox settings where applicable

For Checkout:

- Checkout API base URL
- Flutterwave API key, on the server only; its `sk_test_` or `sk_live_` prefix
  decides whether calls act on test or live sessions
- request timeout

Browser code never holds a Checkout API key. It receives a session's
`client_secret` from the application's server.

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

Develop SDK changes in the owning private product repository. Each product's
own CI publishes that product's releases here: one tag per package and version,
and a GitHub Release on that tag with the package's asset attached. The earlier
shared snapshot exporter has been reverted; do not use the old release task to
publish to this repo.

Two things are common to every product:

- A tag is named for the package's public path and version, such as
  `checkout-sdk-vX.Y.Z` or `auditlog-js-vX.Y.Z`. Go module tags are the
  exception, scoped to the module directory as `auditlog-go/vX.Y.Z`.
- A release asset keeps the file name its pack step gives it: the package name
  with the `@` dropped and `/` as `-`, then the version, such as
  `flutterwavego-checkout-sdk-X.Y.Z.tgz`. A Python wheel keeps its standard
  name, which pip reads the package name and version from. Nothing is renamed
  on upload.

What a tag holds is each product's choice. Auditlog's tags hold the package
source. Checkout's hold each package as released, with its `RELEASE.md`.

An exported Checkout package must name each Checkout package it depends on by
that package's release tarball URL, not by a version. The single-command
installs above rely on it; with a bare version, a lone tarball would look its
dependencies up on the public npm registry.

Published tags and release assets are immutable. If a release is wrong, publish
a new version instead of moving an existing tag.
