### Use `tfv` to manage multiple versions of terraform with ease.
         _        ________        __
       _| |__   / _____|\ \      / /
      |_  ___\ | |___    \ \    / /
        | |    |  ___|    \ \  / /
        | |___ | |         \ \/ /
        \______\_|          \__/

        Happy terraforming 😍🥂!
  ---------------------------------------


> **_NOTE:_** You need to have [nodejs](https://nodejs.org/en/download/) installed on your computer before you can use `tfv`.

# Table of Contents

<!--ts-->
* [Table of Contents](#table-of-contents)
  * [Usage](#usage)
    * [Installation](#installation)
    * [Modules](#modules)
      * [install](#install)
      * [use](#use)
      * [list](#list)
<!--te-->

## Usage
### Installation
> **_NOTE:_** `tfv` should be installed `globally` so that it can be run from anywhere on your computer.
```sh
npm install -g tfv
```

### Modules
#### *install*
```sh
tfv install <version>
```
or
```sh
tfv i <version>
```
| Version          | Description                               |
| ---------------- | ----------------------------------------- |
| x.x.x            | Installs terraform version x.x.x          |
| x^               | Installs latest version of series x       |
| x.x.^            | Installs latest version of series x.x     |
| latest           | Installs latest version of terraform      |

#### *use*
```sh
tfv use <version>
```

| Version          | Description                               |
| ---------------- | ----------------------------------------- |
| x.x.x            | use terraform version x.x.x               |
| x^               | use latest version of series x            |
| x.x.^            | use latest version of series x.x          |
| latest           | use latest version of terraform           |

> **_NOTE:_** If you're using windows OS, you would be prompted for admin privilege. Accept it. This is a one-time request to set terraform location in you system path.

#### *list*
```sh
tfv list [option]
```
or
```sh
tfv ls [option]
```
| Option         | Alias    | Description                 |
| ---------------|--------- | --------------------------------------------------------------------- |
| `--local`      |  `-l`    | Lists all terraform versions installed locally                        |
| `--remote`     |  `-r`    | Lists all terraform versions available remotely, on terraform server  |
|                |          | Defaults to listing terraform versions installed locally              |
