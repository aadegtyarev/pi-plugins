# Surface contract: Pi plugin package distribution

## Boundary and ownership

The `pi-plugins` Git repository is the canonical source for two first-party Pi extensions: `pi-ad-hooks` and `pi-ad-goal`. It also ships the third-party `pi-subagents` package, pinned to an exact version in `dependencies`, because `pi-ad-goal` relies on its documented API. The root `package.json` declares both first-party entry points plus `./node_modules/pi-subagents/bundle/index.js` under `pi.extensions`, the goal skill and `./node_modules/pi-subagents/skills` under `pi.skills`, and `./node_modules/pi-subagents/prompts` under `pi.prompts`. Pi package management owns installation and resource discovery; this repository owns the extension code and compatibility documentation.

## Installation and observable behavior

- Install the public Git package with `pi install git:github.com/aadegtyarev/pi-plugins`. No GitHub credentials are needed to install.
- The package exposes exactly the three extension entry points above. Pi runs `npm install` for a Git package, which installs the pinned pi-subagents. Installing does not configure hook preferences or pi-subagents settings.
- pi-subagents follows its upstream release cycle: Dependabot opens a PR per release, CI runs the compatibility test (`pi-ad-goal/subagents-compat.test.mts`), which executes the release's own RPC constants, completion-notice and output-capping code and a real Pi with the package loaded, and the PR auto-merges only when CI passes. A release that changes what `pi-ad-goal` parses stays unmerged until the code is adapted. Installed copies pick the new version up on the next `pi update`; Pi must then be restarted, because `/reload` cannot replace already loaded pi-subagents modules.
- The extensions use Pi host APIs. Development dependencies support typechecking and tests; Pi runtime modules and `typebox` are peer dependencies, not bundled copies.
- Pi records the package at personal scope by default. Updates follow Pi's package manager; this repository does not automatically update a user's installed version.

## Compatibility and duplicate-loading risks

The extensions are developed and tested against Pi 1.6.0; the manifest does not enforce a minimum Pi version. A standalone extension symlink or copy with the same extension name can load alongside the package resource. Before installing the package, users with legacy standalone paths must resolve the conflict. The same applies to pi-subagents: a separately installed `npm:pi-subagents` entry must be removed from settings, otherwise two copies load. Neither this repository nor `ad-pi-addons` automatically removes, replaces, or retargets existing paths.

## Failure and security behavior

Git installation can fail when GitHub or the npm registry is unreachable; Pi reports the failure. Review the repository before installing because extensions run with the Pi process's permissions. The package itself contains no credentials or user-global hook configuration.

## Non-goals

- Public npm distribution.
- Automatic migration of standalone extension installations.
- Automatic configuration of credentials, hooks, or per-user settings.
- Exactly-once loading when standalone copies and package resources are both configured.

## Related contracts

- [Pi extension authoring](pi-extension-authoring.md)
- [Event hooks](pi-event-hooks.md)
- [Bounded Pi goals](pi-ad-goal.md)
