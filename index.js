#!/usr/bin/env node

const yargs = require('yargs')
const {join} = require('path')

// Finish setup here if the postinstall script never ran.
require('./lib/utils/setup').ensureSetup()

yargs
	.commandDir(join(__dirname, 'lib', 'commands'))
	.alias('help', 'h')
	.scriptName('tfv')
	.showHelpOnFail()
	.argv
