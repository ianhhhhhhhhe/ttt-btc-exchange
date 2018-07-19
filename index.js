/*jslint node: true */
'use strict';
var util = require('util');
var async = require('async');
var bitcore = require('bitcore-lib');
var Transaction = bitcore.Transaction;
var EventEmitter = require('events').EventEmitter;
var client = require('./bitcoin_client.js');
var notifications = require('./notifications.js');
var settlement = require('./settlement.js');
var book = require('./book.js');
var instant = require('./instant.js');
var conf = require('trustnote-common/conf.js');
var constants = require('trustnote-common/constants.js');
var db = require('trustnote-common/db.js');
var mutex = require('trustnote-common/mutex.js');
var eventBus = require('trustnote-common/event_bus.js');
var ValidationUtils = require("trustnote-common/validation_utils.js");
var desktopApp = require('trustnote-common/desktop_app.js');
var headlessWallet = require('trustnote-headless');

let http = require('http')
let url = require('url')

const MIN_CONFIRMATIONS = 2;
const MIN_SATOSHIS = 100000; // typical fee is 0.0008 BTC = 80000 sat

var bTestnet = constants.version.match(/t$/);
var wallet;
var bitcoinNetwork = bTestnet ? bitcore.Networks.testnet : bitcore.Networks.livenet;

let server = http.createServer((request, response) => {
	let args = url.parse(request.url, true).query
	console.log(request.url)
	console.log(args)
	response.writeHead(200, {"Content-Type": "application/json"})
	response.write(JSON.stringify(args))
	response.end();
})

server.listen(8080);
console.log('\n==================\n')
console.log('Server is running')
console.log('\n==================\n')

function readCurrentState(device_address, handleState){
	db.query("SELECT state FROM states WHERE device_address=?", [device_address], function(rows){
		if (rows.length > 0)
			return handleState(rows[0].state);
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

function readCurrentOrderPrice(device_address, order_type, handlePrice){
	var func = (order_type === 'buy') ? 'MAX' : 'MIN';
	db.query(
		"SELECT "+func+"(price) AS best_price FROM note_"+order_type+"er_orders WHERE device_address=? AND is_active=1", 
		[device_address], 
		function(rows){
			if (rows.length === 0)
				return handlePrice(null);
			handlePrice(rows[0].best_price);
		}
	);
}

function updateCurrentPrice(device_address, order_type, price, onDone){
	if (!onDone)
		onDone = function(){};
	db.query("INSERT "+db.getIgnore()+" INTO current_prices (device_address) VALUES (?)", [device_address], function(){
		db.query("UPDATE current_prices SET "+order_type+"_price=? WHERE device_address=?", [price, device_address], function(){
			if (!price)
				return onDone();
			db.query(
				"UPDATE note_"+order_type+"er_orders SET price=?, last_update="+db.getNow()+" WHERE device_address=? AND is_active=1", 
				[price, device_address], 
				function(){
					onDone();
					book.matchUnderLock();
				}
			);
		});
	});
}

function assignOrReadDestinationBitcoinAddress(device_address, out_note_address, handleBitcoinAddress){
	mutex.lock([device_address], function(device_unlock){
		device_unlock()
		return handleBitcoinAddress('tobitcoinaddress');
		db.query("SELECT to_bitcoin_address FROM note_buyer_bindings WHERE out_note_address=?", [out_note_address], function(rows){
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
						"INSERT "+db.getIgnore()+" INTO note_buyer_bindings \n\
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

function exchangeBtcTonotes(note_buyer_deposit_id, onDone){
	if (!onDone)
		onDone = function(){};
	db.query(
		"SELECT satoshi_amount, out_note_address, note_buyer_bindings.device_address, confirmation_date, buy_price \n\
		FROM note_buyer_deposits JOIN note_buyer_bindings USING(note_buyer_binding_id) LEFT JOIN current_prices USING(device_address) \n\
		WHERE note_buyer_deposit_id=?",
		[note_buyer_deposit_id],
		function(rows){
			if (rows.length !== 1)
				throw Error('note buyer deposit not found '+note_buyer_deposit_id);
			var row = rows[0];
			if (row.confirmation_date) // already exchanged
				return onDone();
			db.executeInTransaction(function(conn, onTransactionDone){
				if (row.buy_price)
					book.insertBuyerOrder(conn, note_buyer_deposit_id, row.satoshi_amount, row.device_address, row.buy_price, onTransactionDone);
				else
					instant.handleInstantBuyOrder(conn, note_buyer_deposit_id, row.satoshi_amount, row.device_address, onTransactionDone);
			}, function(){
				updateState(row.device_address, 'done');
				if (row.buy_price)
					book.matchUnderLock();
				else{
					settlement.settleInstantnotes();
					settlement.settleBookBtc();
					instant.updateInstantRates();
				}
				onDone();
			});
		}
	);
}

function exchangeBtcTonotesUnderLock(note_buyer_deposit_id){
	mutex.lock(['btc2notes'], function(unlock){
		exchangeBtcTonotes(note_buyer_deposit_id, unlock);
	});
}

function getBtcBalance(count_confirmations, handleBalance, counter){
	client.getBalance('*', count_confirmations, function(err, btc_balance, resHeaders) {
		if (err){
			// retry up to 3 times
			if (counter >= 3)
				throw Error("getBalance "+count_confirmations+" failed: "+err);
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
		getBtcBalance(0, function(btc_balance) {
			db.query("SELECT SUM(satoshi_amount) AS owed_satoshis FROM note_buyer_orders WHERE is_active=1", function(rows){
				var owed_satoshis = rows[0].owed_satoshis || 0;
				db.query("SELECT SUM(note_amount) AS owed_notes FROM note_seller_orders WHERE is_active=1", function(rows){
					var owed_notes = rows[0].owed_notes || 0;
					if (owed_satoshis > btc_balance*1e8 || owed_notes > note_balance)
						notifications.notifyAdmin("Solvency check failed:\n"+btc_balance+' BTC\n'+(owed_satoshis/1e8)+' BTC owed\n'+note_balance+' notes\n'+owed_notes+' notes owed');
				});
			});
		});
	});
}

function updateInviteCode(from_address, invite_code){
	
}

instant.updateInstantRates();

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
		if (lc_text === 'balance')
			return getBtcBalance(0, function(balance) {
				return getBtcBalance(1, function(confirmed_balance) {
					var unconfirmed_balance = balance - confirmed_balance;
					var btc_balance_str = balance+' BTC';
					if (unconfirmed_balance)
						btc_balance_str += ' ('+unconfirmed_balance+' unconfirmed)';
					db.query("SELECT SUM(satoshi_amount) AS owed_satoshis FROM note_buyer_orders WHERE is_active=1", function(rows){
						var owed_satoshis = rows[0].owed_satoshis || 0;
						db.query("SELECT SUM(note_amount) AS owed_notes FROM note_seller_orders WHERE is_active=1", function(rows){
							var owed_notes = rows[0].owed_notes || 0;
							device.sendMessageToDevice(from_address, 'text', btc_balance_str+'\n'+(owed_satoshis/1e8)+' BTC owed\n'+owed_notes+' notes owed');
						});
					});
				});
			});
	}
	
	readCurrentState(from_address, function(state){
		console.log('state='+state);
		
		if (lc_text === 'buy') {
			device.sendMessageToDevice(from_address, 'text', "Please input your invite_code or click [skip](command:skip).");
			updateCurrentPrice(from_address, 'buy', null);
			return;
		}

		if (lc_text === 'skip') {
			updateInviteCode(from_address, 'Null')
			instant.getBuyRate(function(rates){
				device.sendMessageToDevice(from_address, 'text', "You can:\n[buy notes](command:buy) at "+ rates +" BTC/MN.\n \n\
				Please let me know your address (just click \"...\" button and select \"Insert my address\"");
			})
			return;
		}

		if (lc_text === 'rates' || lc_text === 'rate'){
			instant.getBuyRate(function(rates){
				device.sendMessageToDevice(from_address, 'text', "You can:\n[buy notes](command:buy) at "+ rates +" BTC/MN.");
			})
			return;
		}

		if (lc_text === 'help')
			return device.sendMessageToDevice(from_address, 'text', "List of commands:\n\n\
			[buy](command:buy): send a order\n");

		var arrMatches = text.match(/\b([A-Z2-7]{12})\b/);
		if (arrMatches) {
			updateInviteCode(from_address, arrMatches[0])
			instant.getBuyRate(function(rates){
				device.sendMessageToDevice(from_address, 'text', "You can:\n[buy notes](command:buy) at "+ rates +" BTC/MN.\n \n\
				Please let me know your address (just click \"...\" button and select \"Insert my address\"");
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
				});
				updateState(from_address, 'waiting_for_payment');
				// exchangeService.bus.subscribe('bitcoind/addresstxid', [to_bitcoin_address]);
			});
			return;
		}
		else if (state === 'waiting_for_trustnote_address' && !bSetNewPrice)
			return device.sendMessageToDevice(from_address, 'text', "This doesn't look like a valid note address.  Please click \"...\" button at the bottom of the screen and select \"Insert my address\", then hit \"Send\" button.");
		
		if (bSetNewPrice)
			return;
		
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

