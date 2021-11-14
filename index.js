#!/usr/bin/env node

const yargs = require('yargs')
const {join} = require('path')

yargs
	.commandDir(join(__dirname, 'lib', 'commands'))
	.alias('help', 'h')
	.scriptName('tfv')
	.demandCommand(1, 'You need at least one command before moving on')
	.strictOptions()
	// .strictCommands()
	.showHelpOnFail()
	.argv
