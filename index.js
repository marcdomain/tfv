#!/usr/bin/env node

const yargs = require('yargs')
const {join} = require('path')

// Finish setup here if the postinstall script never ran.
require('./lib/utils/setup').ensureSetup()

// `teriac`, `teriac --help`: a grouped table of commands. Per-command help stays with yargs.
const { helpTable, wantsTopHelp } = require('./lib/utils/help')
if (wantsTopHelp(process.argv.slice(2))) {
	process.stdout.write(helpTable({ color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR }))
	process.exit(0)
}

yargs
	.commandDir(join(__dirname, 'lib', 'commands'))
	.alias('help', 'h')
	.scriptName('teriac')
	.showHelpOnFail()
	.argv
