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

# Table of Contents

<!--ts-->
* [Table of Contents](#table-of-contents)
  * [Usage](#usage)
    * [Modules](#modules)
      * [install](#install)
      * [use](#use)
      * [list](#list)
      * [remove](#remove)
      * [auto-switch](#auto-switch)
<!--te-->

## Usage

<https://user-images.githubusercontent.com/25563661/142188036-4f2a8b65-1a3e-4298-95e0-9ed533c66a18.mp4>

### Modules

- #### _INSTALL_

```sh
tfv install <version>
```

Run with alias

```sh
tfv i <version>
```

| Version          | Description                                |
| ---------------- | ------------------------------------------ |
| x.x.x            | Installs terraform version x.x.x           |
| x^               | Installs latest version of release x       |
| x.x.^            | Installs latest version of release x.x     |
| latest           | Installs latest version of terraform       |

- #### _USE_

```sh
tfv use <version>
```

| Version          | Description                               |
| ---------------- | ----------------------------------------- |
| x.x.x            | use terraform version x.x.x               |
| latest           | use latest version of terraform           |

> **_NOTE:_** If you're using windows OS, you would be prompted for admin privilege. Accept it. This is a one-time request to set terraform location in you system path. Unix machines would also get password prompt, as this requires permission to copy terraform to your bin directory.

- #### _LIST_

```sh
tfv list [option]
```

Run with alias

```sh
tfv ls [option]
```

| Option         | Option Alias  |                Description                                                     |
| ---------------|---------------|--------------------------------------------------------------------------------|
|                |               |  Defaults to listing terraform versions installed locally (in tfv store)       |
| `--local`      |  `-l`         |  Lists all terraform versions installed locally                                |
| `--remote`     |  `-r`         |  Lists all terraform versions available remotely, on terraform server          |

- #### _REMOVE_

```sh
  tfv remove <version>
```

Run with alias

```sh
  tfv rm <version>
```

| Version          | Description                               |
| ---------------- | ----------------------------------------- |
| x.x.x            | remove terraform version x.x.x            |

- #### _AUTO-SWITCH_

```sh
  tfv auto-switch
```

Run with alias

```sh
  tfv as
```

| Description                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- |
| auto-detects your project terraform version, downloads it if it's not in tfv store, and switch to the version     |
