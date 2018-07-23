/*jslint node: true */
'use strict';
var bitcoin = require('bitcoin');

var client = new bitcoin.Client({
	host: 'localhost',
	port: 28332,
	user: 'bitcoin',
	pass: 'local321',
	timeout: 60000
});

module.exports = client;
