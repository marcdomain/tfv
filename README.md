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
  tfv install <version>  Example: tfv install 1.0.11                [aliases: i]
  tfv list [option]      Example: tfv list --local                 [aliases: ls]
  tfv remove <version>   Example: tfv rm 1.0.11                    [aliases: rm]
  tfv auto-switch        Example: tfv as                           [aliases: as]
  tfv use <version>      Example: tfv use 1.0.11

Options:
  -h, --help     Show help                                             [boolean]
  -v, --version  Show version number                                   [boolean]
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

https://user-images.githubusercontent.com/25563661/209584148-05a86ee1-f497-4c6d-9894-d9cb464ef5b8.mp4

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
