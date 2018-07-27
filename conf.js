/*jslint node: true */
"use strict";

//exports.port = 6611;
//exports.myUrl = 'wss://mydomain.com/bb';
exports.bServeAsHub = false;
exports.bLight = false;
exports.bIgnoreUnpairRequests = true;

exports.storage = 'sqlite';


exports.hub = 'victor.trustnote.org/tn';
exports.deviceName = 'exchange';
exports.permanent_pairing_secret = '0000';
exports.control_addresses = ['DEVICE ALLOWED TO CHAT'];
exports.payout_address = 'WHERE THE MONEY CAN BE SENT TO';

exports.MIN_AMOUNT_IN_KB = 50;
exports.MAX_AMOUNT_IN_KB = 100;

exports.KEYS_FILENAME = 'keys.json';

console.log('finished faucet conf');
