# Collector Figures Chat Web/PWA

This repository is the complete AGPL source for the Collector Figures branded Web/PWA client. It is based on Element
Web v1.12.26 and keeps the upstream project history, license files, build system and dependency lock file.

- Product: **Collector Figures Chat**
- Upstream tag: `v1.12.26`
- Upstream commit: `c43ef70b55030287677d884f8a3073808c4301d9`
- License for Collector Figures modifications: `AGPL-3.0-only`
- Official Element X apps are optional third-party clients and are not Collector Figures branded apps.
- Native Collector Figures iOS and Android apps are deferred and are not part of this repository.

See [CFS-UPSTREAM.md](./CFS-UPSTREAM.md), [MODIFICATIONS.md](./MODIFICATIONS.md), and
[OPEN-SOURCE-NOTICES.md](./OPEN-SOURCE-NOTICES.md) before building or redistributing this fork.

## Upstream Element documentation

Element (formerly known as Vector and Riot) is a Matrix web & desktop client built using the [Matrix
JS SDK](https://github.com/matrix-org/matrix-js-sdk).

# Supported Environments

Element has several tiers of support for different environments:

- Supported
    - Definition:
        - Issues **actively triaged**, regressions **block** the release
    - Last 2 major versions of Chrome, Firefox, and Edge on desktop OSes
    - Last 2 versions of Safari
    - Latest release of official Element Desktop app on desktop OSes
    - Desktop OSes means macOS, Windows, and Linux versions for desktop devices
      that are actively supported by the OS vendor and receive security updates
- Best effort
    - Definition:
        - Issues **accepted**, regressions **do not block** the release
        - The wider Element Products (including Element Call and the Enterprise Server Suite) do still not officially support these browsers.
        - The element web project and its contributors should keep the client functioning and gracefully degrade where other sibling features (E.g. Element Call) may not function.
    - Last major release of Firefox ESR and Chrome/Edge Extended Stable
- Community Supported
    - Definition:
        - Issues **accepted**, regressions **do not block** the release
        - Community contributions are welcome to support these issues
    - Mobile web for current stable version of Chrome, Firefox, and Safari on Android, iOS, and iPadOS
- Not supported
    - Definition: Issues only affecting unsupported environments are **closed**
    - Everything else

The period of support for these tiers should last until the releases specified above, plus 1 app release cycle(2 weeks). In the case of Firefox ESR this is extended further to allow it land in Debian Stable.

For accessing Element on an Android or iOS device, we currently recommend the
native apps [element-x-android](https://github.com/element-hq/element-x-android)
and [element-x-ios](https://github.com/element-hq/element-x-ios).

# Getting Started

The easiest way to test Element is to just use the hosted copy at <https://app.element.io>.
The `develop` branch is continuously deployed to <https://develop.element.io>
for those who like living dangerously.

To host your own instance of Element see [Installing Element Web](docs/install.md).

To install Element as a desktop application, see [Running as a desktop app](#running-as-a-desktop-app) below.

---

# Monorepo

This repository is a monorepo hosting Element Web and other related projects in various subdirectories.
You can read more about the structure [here](docs/monorepo.md).

# Element Web

To learn more about Element Web [click here](apps/web/README.md)

# Running as a Desktop app

Element can also be run as a desktop app, wrapped in Electron. You can download a
pre-built version from <https://element.io/get-started> or, if you prefer,
build it yourself.

To build it yourself, follow the instructions at <https://github.com/element-hq/element-web/tree/develop/apps/desktop>.

Many thanks to @aviraldg for the initial work on the Electron integration.

The [configuration docs](docs/config.md#desktop-app-configuration) show how to override the desktop app's default settings if desired.

# Development

Please read through the following:

1. [Developer guide](./developer_guide.md)
2. [Code style](./code_style.md)
3. [Contribution guide](./CONTRIBUTING.md)

# Translations

To add a new translation, head to the [translating doc](docs/translating.md).

For a developer guide, see the [translating dev doc](docs/translating-dev.md).

# Triaging issues

Issues are triaged by community members and the Web App Team, following the [triage process](https://github.com/element-hq/element-meta/wiki/Triage-process).

We use [issue labels](https://github.com/element-hq/element-meta/wiki/Issue-labelling) to sort all incoming issues.

## Copyright & License

Copyright (c) 2014-2017 OpenMarket Ltd
Copyright (c) 2017 Vector Creations Ltd
Copyright (c) 2017-2025 New Vector Ltd

This software is multi licensed by New Vector Ltd (Element). It can be used either:

(1) for free under the terms of the GNU Affero General Public License (as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version); OR

(2) for free under the terms of the GNU General Public License (as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version); OR

(3) under the terms of a paid-for Element Commercial License agreement between you and Element (the terms of which may vary depending on what you and Element have agreed to).
Unless required by applicable law or agreed to in writing, software distributed under the Licenses is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the Licenses for the specific language governing permissions and limitations under the Licenses.

Please contact [licensing@element.io](mailto:licensing@element.io) to purchase
an Element commercial license for this software.
