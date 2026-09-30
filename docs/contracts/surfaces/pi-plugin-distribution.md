# Surface contract: Pi plugin package distribution

## Boundary and ownership

The `pi-plugins` Git repository is the canonical source for three first-party Pi extensions: `pi-ad-telegram`, `pi-ad-session-usage`, and `pi-ad-hooks`. Its root `package.json` declares their entry points under `pi.extensions`. Pi package management owns installation and resource discovery; this repository owns the extension code and compatibility documentation.

## Installation and observable behavior

- Install the private Git package with `pi install git:github.com/aadegtyarev/pi-plugins`. GitHub authentication must already permit access to the repository.
- The package exposes exactly the three extension entry points above. Installing it does not configure Telegram credentials or hook preferences.
- When both Telegram and session-usage extensions are loaded, the Telegram extension observes the public custom-message lifecycle and forwards only `pi-ad-session-usage:report` text for Telegram-associated work. Structured details and unrelated custom messages are not forwarded. This integration does not depend on manifest entry order.
- The extensions use Pi host APIs. Development dependencies support typechecking and tests; Pi runtime modules are peer dependencies, not bundled copies.
- Pi records the package at personal scope by default. Updates follow Pi's package manager; this repository does not automatically update a user's installed version.

## Compatibility and duplicate-loading risks

The extensions are developed and tested against Pi 0.99.0; the manifest does not enforce a minimum Pi version. A standalone extension symlink or copy with the same extension name can load alongside the package resource. Before installing the package, users with legacy standalone paths must resolve the conflict. Neither this repository nor `ad-pi-addons` automatically removes, replaces, or retargets existing paths.

## Failure and security behavior

Private Git installation can fail when GitHub credentials are missing or invalid; Pi reports the failure. Review the repository before installing because extensions run with the Pi process's permissions. The package itself contains no bot tokens or user-global hook configuration.

## Non-goals

- Public npm distribution or public repository access.
- Automatic migration of standalone extension installations.
- Automatic configuration of credentials, hooks, or per-user settings.
- Exactly-once loading when standalone copies and package resources are both configured.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Telegram bridge](pi-ad-telegram.md)
- [Event hooks](pi-event-hooks.md)
- [Session usage reporting](session-usage-reporting.md)
