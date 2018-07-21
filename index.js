/*jslint node: true */
'use strict';
var bitcore = require('bitcore-lib');
var Transaction = bitcore.Transaction;
var client = require('./bitcoin_client.js');
var notifications = require('./notifications.js');
var instant = require('./instant.js');
var conf = require('trustnote-common/conf.js');
var constants = require('trustnote-common/constants.js');
var db = require('trustnote-common/db.js');
var mutex = require('trustnote-common/mutex.js');
var eventBus = require('trustnote-common/event_bus.js');
var ValidationUtils = require("trustnote-common/validation_utils.js");
var desktopApp = require('trustnote-common/desktop_app.js');
var headlessWallet = require('trustnote-headless');
var createPayment = require('./create_payment')

let request = require('request')
let http = require('http')
let url = require('url')

const MIN_CONFIRMATIONS = 2;
const MIN_SATOSHIS = 100000; // typical fee is 0.0008 BTC = 80000 sat

var bTestnet = true;
var wallet;
var bitcoinNetwork = bTestnet ? bitcore.Networks.testnet : bitcore.Networks.livenet;

function payToAddress(args, callback) {
	var address = args.address
	var amount = args.amount
	return callback(args)
	var Wallet = require('trustnote-common/wallet.js');
	Wallet.readBalance(wallet, function(assocBalances){
		var note_balance = assocBalances['base'].stable + assocBalances['base'].pending;
		if(note_balance < amount) {
			return callback('Not Enough Fund')
		}
		createPayment(address, amount, callback)
	})
}

function getBtcBalanceFromAddress(args, callback) {
	request({
		url: 'https://blockchain.info/balance?active='+args.address,
	 }, (error, response, body) => {
		if (error){
			return callback(error);
		} else if (response.statusCode != 200) {
			return callback(error, response.statusCode);
		}
		body = JSON.parse(body)
		var balance = body[args.address].final_balance
		return callback(error, response.statusCode, balance)
	})
}

function getWalletBalance(callback){
	var Wallet = require('trustnote-common/wallet.js');
	Wallet.readBalance(wallet, function(assocBalances){
		var note_balance = assocBalances['base'].stable + assocBalances['base'].pending;
		callback({
			"balance": note_balance,
			"stable": assocBalances['base'].stable,
			"pending": assocBalances['base'].pending
		})
	});
}

// TODO
function getUserStatus(args){
	return JSON.stringify(args)
}

function postTranferResult(args, callback) {
	return callback(args)
}

function NotFound(callback){
	callback()
}

// HTTP Server TODO
let server = http.createServer((request, response) => {
	let path = url.parse(request.url, true).pathname
	let args = url.parse(request.url, true).query
	if (request.method == 'GET') {
		let content = {
			"code": 200,
			"msg": "Success",
			"detailMsg": null,
			"data": null
		}
		response.writeHead(200, {"Content-Type": "application/json"})
		switch (path) {
			case '/getBtcBalance':
				return getBtcBalanceFromAddress(args, function(error, status_code, body){
					content.data = body
					if(error) {
						content.detailMsg = JSON.stringify(error)
						content.msg = 'Failed'
					}
					content.code = status_code ? status_code : 200
					response.write(JSON.stringify(content))
					response.end();
				})
			case '/getWalletBalance':
				return getWalletBalance(function(balance){
					content.data = balance
					response.write(JSON.stringify(content))
					response.end();
				})
			case '/payToAddress':
			    return payToAddress(args, function(res){
					if(JSON.stringify(res)=='Not Enough Fund') {
						content.code = 500
						content.msg = 'Error'
					} else if (JSON.stringify(res)=='Uncorrect Address') {
						content.code = 500
						content.msg = 'Uncorrect Address'
					} else {
						content.data = res
					}
					response.write(JSON.stringify(content))
					response.end()
				})
			default:
			    return NotFound(() => {
					content.code = 404
					content.msg = 'Not Found'
					response.write(JSON.stringify(content))
					response.end()
				})
				break;
		}
	} else if (request.method == 'POST') {
		let path = url.parse(request.url, true).pathname
		var data = '';
		let content = {
			"code": 200,
			"msg": "Success",
			"detailMsg": null,
			"data": null
		}
		response.writeHead(200, {"Content-Type": "application/json"})
		request.on('data', function (chunk) {
			// chunk 默认是一个二进制数据，和 data 拼接会自动 toString
			data += chunk;
		});
		request.on('end', function () {
			console.log(data);
			content.data = JSON.parse(data)
			switch(path){
				case '/postTransferResult':
				    return postTranferResult(data, function(res){
						content.data = res
						response.write(JSON.stringify(content))
						response.end()
					})
				default:
					return NotFound(function(){
						content.code = 404
						content.msg = 'Not Found'
						content.data = null
						response.write(JSON.stringify(content))
						response.end()
					})
			}
		});
	}
})

server.listen(9000);
console.log('\n==================\n')
console.log('Server is running')
console.log('\n==================\n')

function postUserOrder(device_address, to_bitcoin_address, ttt_address, invite_code, quantity, receipt, rate, states, callback) {
	var json = {
		'currency': 'TTT',
		'payment': 'BTC',
		'quantity': quantity,
		'receipt': receipt,
		'toAddress': to_bitcoin_address,
		'tttAddress': ttt_address,
		'deviceAddress': device_address,
		'rate': rate,
		'states': states,
		'inviteCode': invite_code
	}
	request({
		url: '/exchange-order/save-order.htm',
		method: 'POST',
		body: JSON.stringify(json)
	}, (error, response, body) => {
		if (error){
			return callback(error);
		} else if (response.statusCode != 200) {
			return callback(error, response.statusCode);
		}
		return callback(error, response.statusCode, body)
	})
}

function recordUserOrder(device_address, to_bitcoin_address, ttt_address) {
	db.query('select * from note_buyer_orders where device_address=?', [device_address], function(rows){
		if(rows.length===0){
			db.query('insert into note_buyer_orders (out_note_address, to_bitcoin_address,\n\
				device_address) values (?,?,?)', [ttt_address, to_bitcoin_address, device_address], function() {
				})
		}
	})
	updateState(from_address, 'waiting_for_confirmations')
}

function readCurrentState(device_address, handleState){
	db.query("SELECT state, invite_code FROM states WHERE device_address=?", [device_address], function(rows){
		if (rows.length > 0)
			return handleState(rows[0].state, rows[0].invite_code);
		var state = "greeting";
		db.query("INSERT "+db.getIgnore()+" INTO states (device_address, state) VALUES (?,?)", [device_address, state], function(){
			handleState(state);
		});
	});
}

function updateState(device_address, state, onDone){
	db.query("UPDATE states SET state=? WHERE device_address=?", [state, device_address], function(){
		if (onDone)
			onDone();
	});
}

function assignOrReadDestinationBitcoinAddress(device_address, out_note_address, handleBitcoinAddress){
	mutex.lock([device_address], function(device_unlock){
		device_unlock()
		return handleBitcoinAddress('tobitcoinaddress');
		db.query("SELECT to_bitcoin_address FROM note_buyer_orders WHERE out_note_address=?", [out_note_address], function(rows){
			if (rows.length > 0){ // already know this note address
				device_unlock()
				return handleBitcoinAddress(rows[0].to_bitcoin_address);
			}
			// generate new address
			mutex.lock(["new_bitcoin_address"], function(unlock){
				client.getNewAddress(function(err, to_bitcoin_address, resHeaders) {
					if (err)
						throw Error(err);
					console.log('BTC Address:', to_bitcoin_address);
					db.query(
						"INSERT "+db.getIgnore()+" INTO note_buyer_orders \n\
						(device_address, out_note_address, to_bitcoin_address) VALUES (?,?,?)", 
						[device_address, out_note_address, to_bitcoin_address],
						function(){
							unlock();
							device_unlock();
							handleBitcoinAddress(to_bitcoin_address);
						}
					);
				});
			});
		});
	});
}

function getBtcBalance(count_confirmations, handleBalance, counter){
	client.getBalance('*', count_confirmations, function(err, btc_balance, resHeaders) {
		if (err){
			// retry up to 3 times
			if (counter >= 3)
				return notifications.notifyAdmin("getBalance "+count_confirmations+" failed: "+err);
			counter = counter || 0;
			console.log('getBalance attempt #'+counter+' failed: '+err);
			setTimeout( () => {
				getBtcBalance(count_confirmations, handleBalance, counter + 1);
			}, 60*1000);
			return;
		}
		handleBalance(btc_balance);
	});
}

function checkSolvency(){
	var Wallet = require('trustnote-common/wallet.js');
	Wallet.readBalance(wallet, function(assocBalances){
		var note_balance = assocBalances['base'].stable + assocBalances['base'].pending;
		if(note_balance <= 1000000000000) {
			notifications.notifyAdmin("Not enough balance: " + note_balance);
		}
	});
}

function updateInviteCode(from_address, invite_code, callback){
	db.query('update states set invite_code=? where device_address=?', [invite_code, from_address], () => {})
}

function updateConfirm(from_address, to_bitcoin_address, amount, rate) {
	db.query('select invite_code from states where device_address=?', [from_address], function(rows) {
		let invite_code = rows[0].invite_code;
		db.query('select * from note_buyer_orders where device_address=?', [from_address], function(rows){
			let ttt_address = rows[0].out_note_address;
			postUserOrder(from_address, to_bitcoin_address, ttt_address, invite_code, amount, null, rate, "已完成")
		})
	})
}

// setInterval(checkSolvency, 10000);

var bHeadlessWalletReady = false;
eventBus.once('headless_wallet_ready', function(){
	if (!conf.admin_email || !conf.from_email){
		console.log("please specify admin_email and from_email in your "+desktopApp.getAppDataDir()+'/conf.json');
		process.exit(1);
	}
	headlessWallet.setupChatEventHandlers();
	headlessWallet.readSingleWallet(function(_wallet){
		wallet = _wallet;
		bHeadlessWalletReady = true;
	});
});

eventBus.on('paired', function(from_address){
	readCurrentState(from_address, function(state){
		var device = require('trustnote-common/device');
		if (state === 'waiting_for_confirmations')
			return device.sendMessageToDevice(from_address, 'text', "Received your payment and waiting that it is confirmed.");
		updateState(from_address, 'greeting');
		device.sendMessageToDevice(from_address, 'text', "Welcome to exchange serivce, click [buy](command:buy) to buy TTT");
	});
});

eventBus.on('text', function(from_address, text){
	var device = require('trustnote-common/device');
	text = text.trim();
	var lc_text = text.toLowerCase();

	if(lc_text == 'hello') {
		updateState(from_address, 'greeting');
		return device.sendMessageToDevice(from_address, 'text', 'hello');
	}
	
	if (headlessWallet.isControlAddress(from_address)){
		if (lc_text === 'balance') {
			return getBtcBalance(0, function(balance) {
				return getBtcBalance(1, function(confirmed_balance) {
					var unconfirmed_balance = balance - confirmed_balance;
					var btc_balance_str = balance+' BTC';
					if (unconfirmed_balance)
						btc_balance_str += ' ('+unconfirmed_balance+' unconfirmed)';
					device.sendMessageToDevice(from_address, 'text', btc_balance_str+'\n');
				});
			});
		}
	}
	
	readCurrentState(from_address, function(state, invite_code){
		console.log('state='+state);
		
		if (lc_text === 'buy') {
			device.sendMessageToDevice(from_address, 'text', "Please input your invite_code or click [skip](command:skip).");
			return;
		}

		if (lc_text === 'skip') {
			updateInviteCode(from_address, '00000000')
			instant.getBuyRate(function(rates){
				device.sendMessageToDevice(from_address, 'text', "You can: buy notes at "+ rates +" BTC/MN.\n \n\
				Please let me know your address (just click \"...\" button and select \"Insert my address\"");
			})
			return;
		}

		if (lc_text === 'rates' || lc_text === 'rate'){
			instant.getBuyRate(function(rates){ 
				device.sendMessageToDevice(from_address, 'text', "You can: buy notes at "+ rates +" BTC/MN.");
			})
			return;
		}

		if (lc_text === 'help')
			return device.sendMessageToDevice(from_address, 'text', "List of commands:\n\n\
			[buy](command:buy): send a order\n");

		var arrMatches = text.match(/\b([A-Z0-9]{12})\b/);
		if (arrMatches) {
			updateInviteCode(from_address, arrMatches[0])
			instant.getBuyRate(function(rates){
				device.sendMessageToDevice(from_address, 'text', "You can:buy notes at "+ rates +" BTC/MN.\nPlease let me know your address (just click \"...\" button and select \"Insert my address\"");
			})
			return;
		}
		
		var arrMatches = text.match(/\b([A-Z2-7]{32})\b/);
		var bValidnoteAddress = (arrMatches && ValidationUtils.isValidAddress(arrMatches[1]));
		if (bValidnoteAddress){ // new BB address: create or update binding
			var out_note_address = arrMatches[1];
			assignOrReadDestinationBitcoinAddress(from_address, out_note_address, function(to_bitcoin_address){
				instant.getBuyRate(function(buy_price){
					var will_do_text = 'Your bitcoins will be added to the [book](command:book) at '+buy_price+' BTC/MN when the payment has at least '+MIN_CONFIRMATIONS+' confirmations.'
					var maximum_text = buy_price ? "" : "maximum amount is "+instant.MAX_BTC+" BTC,";
					device.sendMessageToDevice(from_address, 'text', "Got it, you'll receive your notes to "+out_note_address+".  Now please pay BTC to "+to_bitcoin_address+".  We'll exchange as much as you pay, but the "+maximum_text+" minimum is "+(MIN_SATOSHIS/1e8)+" BTC (if you send less, it'll be considered a donation).  "+will_do_text);
					recordUserOrder(from_address, to_bitcoin_address, out_note_address, invite_code)
				});
				updateState(from_address, 'waiting_for_payment');
				// exchangeService.bus.subscribe('bitcoind/addresstxid', [to_bitcoin_address]);
			});
			return;
		}
		else if (state === 'waiting_for_trustnote_address')
			return device.sendMessageToDevice(from_address, 'text', "This doesn't look like a valid note address.  Please click \"...\" button at the bottom of the screen and select \"Insert my address\", then hit \"Send\" button.");
		
		switch(state){
			case 'greeting':
				device.sendMessageToDevice(from_address, 'text', "To start an exchange, see the current [rates](command:rates).");
				break;
				
			case 'waiting_for_payment':
				device.sendMessageToDevice(from_address, 'text', "Waiting for your payment.  If you want to start another exchange, see the current [rates](command:rates).");
				break;

			case 'waiting_for_confirmations':
				device.sendMessageToDevice(from_address, 'text', "Received your payment and waiting that it is confirmed.");
				break;
				
			case 'done':
				device.sendMessageToDevice(from_address, 'text', "If you want to start another exchange, see the current [rates](command:rates).");
				break;
				
			default:
				throw Error("unknown state: "+state);
		}
	});
});

