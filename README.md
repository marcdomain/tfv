# Use `tfv` to manage multiple versions of terraform with ease

         _        ________        __
       _| |__   / _____|\ \      / /
      |_  ___\ | |___    \ \    / /
        | |    |  ___|    \ \  / /
        | |___ | |         \ \/ /
        \______\_|          \__/

        Happy terraforming 😍🥂!
  ---------------------------------------

## Installation

> **_NOTE:_** `tfv` should be installed `globally` so that it can be run from anywhere on your computer.

```sh
npm install -g tfv
```

Run with alias

```sh
npm i -g tfv
```

## Help

```sh
tfv --help
```

Run with alias

```sh
tfv -h
```

> **_OUTPUT:_**

```
tfv <command>

Commands:
  tfv install <version> [option] Example: tfv install 1.0.11       [aliases: i]
  tfv list [option]      Example: tfv list                         [aliases: ls]
  tfv remove <version>   Example: tfv rm 1.0.11                    [aliases: rm]
  tfv auto-switch        Example: tfv as                           [aliases: as]
  tfv use <version>      Example: tfv use 1.0.11

Options:
  -h, --help     Show help                                             [boolean]
  -v, --version  Show version number                                   [boolean]
```

# Usage

https://github.com/marcdomain/tfv/assets/25563661/fa44f0f2-2dca-4f22-9fea-c74e4b8f767c

# Table of Contents

<!--ts-->
* [Table of Contents](#table-of-contents)
    * [Modules](#modules)
      * [install](#install)
      * [use](#use)
      * [list](#list)
      * [remove](#remove)
      * [auto-switch](#auto-switch)
<!--te-->

### Modules

- #### _INSTALL_

| Version          | Description                                |
| ---------------- | ------------------------------------------ |
| x.x.x            | Installs terraform version x.x.x           |
| x^               | Installs latest version of release x       |
| x.x.^            | Installs latest version of release x.x     |
| latest           | Installs latest version of terraform       |

```sh
tfv install <version>
```

Run with option

```sh
tfv install <version> --arch <system-architecture>
```

EXAMPLE:

```sh
tfv install 1.5.7 -arch amd64
```

> NOTE:  The default *system-architecture* is the architecture of your computer (arm64, amd64, x64, etc...)

- #### _USE_

| Version          | Description                               |
| ---------------- | ----------------------------------------- |
| x.x.x            | use terraform version x.x.x               |
| latest           | use latest version of terraform           |

```sh
tfv use <version>
```

> **_NOTE:_** You would get a password prompt. Accept it. This is a one-time request to set the terraform executable in your system path.

- #### _LIST_

| Option         | Option Alias  |                Description                                                     |
| ---------------|---------------|--------------------------------------------------------------------------------|
|                |               |  Defaults to listing terraform versions installed locally (in tfv store)       |
| `--local`      |  `-l`         |  Lists all terraform versions installed locally                                |
| `--remote`     |  `-r`         |  Lists all terraform versions available remotely, on terraform server          |

```sh
tfv list [option]
```

Run with alias

```sh
tfv ls [option]
```

- #### _REMOVE_

Remove terraform versions managed by tfv

```sh
  tfv remove <versions>
```

Run with alias

```sh
  tfv rm <versions>
```

Example

```sh
  tfv rm x.y.z z.x.y
```

- #### _AUTO-SWITCH_

Auto-detects your project terraform version, downloads it if it's not in tfv store, and switch to the version

```sh
  tfv auto-switch
```

Run with alias

```sh
  tfv as
```
