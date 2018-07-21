/*jslint node: true */
"use strict";
var headlessWallet = require('trustnote-headless/start.js');
var eventBus = require('trustnote-common/event_bus.js');
var validationUtil = require('trustnote-common/validation_utils');

function onError(err){
	throw Error(err);
}

function createPayment(payee_address, amount, callback){
	var composer = require('trustnote-common/composer.js');
	var network = require('trustnote-common/network.js');
	var callbacks = composer.getSavingCallbacks({
		ifNotEnoughFunds: onError,
		ifError: onError,
		ifOk: function(objJoint){
			network.broadcastJoint(objJoint);
		}
	});

	var from_address = "QJ46SU2OG4WFQ5DW25ULT64ZJKB5MQKO";
	var arrOutputs = [
		{address: from_address, amount: 0},      // the change
		{address: payee_address, amount: parseFloat(amount)}  // the receiver
	];
    composer.composePaymentJoint([from_address], arrOutputs, headlessWallet.signer, callbacks);
    callback('Success')
}

exports.createPayment = createPayment