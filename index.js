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

function readCurrentPrices(device_address, handlePrices){
	db.query("SELECT buy_price, sell_price FROM current_prices WHERE device_address=?", [device_address], function(rows){
		if (rows.length === 0)
			return handlePrices(null, null);
		handlePrices(rows[0].buy_price, rows[0].sell_price);
	});
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

function initChat(exchangeService){
	
	// wait and repeat
	if (!bHeadlessWalletReady){
		eventBus.once('headless_wallet_ready', function(){
			bHeadlessWalletReady = true;
			initChat(exchangeService);
		});
		return;
	}
	
	var bbWallet = require('trustnote-common/wallet.js');
	var device = require('trustnote-common/device.js');
	
	function readCurrentHeight(handleCurrentHeight){
		exchangeService.node.services.bitcoind.getInfo(function(err, currentInfo){
			if (err)
				throw Error("getInfo failed: "+err);
			handleCurrentHeight(currentInfo.blocks);
		});
	}
	
	function refreshCountConfirmations(txid, old_count_confirmations, handleNewCountConfirmations){
		exchangeService.node.services.bitcoind.getDetailedTransaction(txid, function(err, info) {
			if (err){
				console.log("refreshCountConfirmations: getDetailedTransaction "+txid+" failed: "+err);
				return handleNewCountConfirmations();
			}
			console.log('getDetailedTransaction: ', info);
			var bUnconfirmed = (!info.height || info.height === -1);
			if (bUnconfirmed && old_count_confirmations === 0) // still in mempool
				return handleNewCountConfirmations();
			readCurrentHeight(function(currentHeight){
				var count_confirmations = bUnconfirmed ? 0 : (currentHeight - info.height + 1);
				if (count_confirmations === old_count_confirmations) // same as before
					return handleNewCountConfirmations();
				// we also update if count_confirmations decreased due to reorg (block orphaned and the tx thrown back into mempool)
				db.query(
					"UPDATE note_buyer_deposits SET count_confirmations=? WHERE txid=?", [count_confirmations, txid], 
					function(){
						handleNewCountConfirmations(count_confirmations);
					}
				);
			});
		});
	}
	
	function updateConfirmationCountOfRecentTransactionsAndExchange(min_confirmations, onDone){
		mutex.lock(['btc2notes'], function(unlock){
			db.query(
				"SELECT txid, count_confirmations, GROUP_CONCAT(note_buyer_deposit_id) AS deposits \n\
				FROM note_buyer_deposits WHERE confirmation_date IS NULL GROUP BY txid", 
				function(rows){
					async.eachSeries(
						rows,
						function(row, cb){
							refreshCountConfirmations(row.txid, row.count_confirmations, function(count_confirmations){
								if (!count_confirmations)
									count_confirmations = row.count_confirmations;
								if (count_confirmations < min_confirmations)
									return cb();
								var arrDepositIds = row.deposits.split(',');
								async.eachSeries(
									arrDepositIds,
									function(note_buyer_deposit_id, cb2){
										exchangeBtcTonotes(note_buyer_deposit_id, cb2);
									},
									cb
								);
							});
						},
						function(){
							unlock();
							if (onDone)
								onDone();
						}
					);
				}
			);
		});
	}
	
	function rescanForLostTransactions(){
		db.query(
			"SELECT note_buyer_bindings.* \n\
			FROM note_buyer_bindings \n\
			LEFT JOIN note_buyer_deposits USING(note_buyer_binding_id) \n\
			WHERE note_buyer_deposits.note_buyer_binding_id IS NULL",
			function(rows){
				if (rows.length === 0)
					return;
				var arrToBitcoinAddresses = rows.map(function(row){ return row.to_bitcoin_address; });
				console.log('waiting to BTC addresses: '+arrToBitcoinAddresses.length);
				exchangeService.node.services.bitcoind.getAddressHistory(arrToBitcoinAddresses, {}, function(err, history){
					if (err)
						throw Error('rescan getAddressHistory failed: '+err);
					console.log('lost transactions: '+history.items.length, history);
					history.items.forEach(function(item){
						var arrAddresses = Object.keys(item.addresses);
						if (arrAddresses.length > 1)
							throw Error('more than 1 to-address');
						var to_bitcoin_address = arrAddresses[0];
						var txid = item.tx.hash;
						handleNewTransaction(txid, to_bitcoin_address);
					});
				});
			}
		);
	}
	
	/////////////////////////////////
	// start
	
	rescanForLostTransactions();
	
	
	// subscribe to bitcoin addresses where we expect payment
	db.query(
		"SELECT to_bitcoin_address FROM note_buyer_bindings", // user can pay more than once
		function(rows){
			if (rows.length === 0)
				return;
			var arrToBitcoinAddresses = rows.map(function(row){ return row.to_bitcoin_address; });
			exchangeService.bus.subscribe('bitcoind/addresstxid', arrToBitcoinAddresses);
			console.log("subscribed to:", arrToBitcoinAddresses);
		}
	);
	
	// update confirmations count of recent transactions
	setTimeout(function(){
		updateConfirmationCountOfRecentTransactionsAndExchange(MIN_CONFIRMATIONS);
	}, 20000);
	setInterval(checkSolvency, 10000);

	eventBus.on('paired', function(from_address){
		readCurrentState(from_address, function(state){
			if (state === 'waiting_for_confirmations')
				return device.sendMessageToDevice(from_address, 'text', "Received your payment and waiting that it is confirmed.");
			updateState(from_address, 'greeting');
			device.sendMessageToDevice(from_address, 'text', "Here you can:\n[buy notes](command:buy) at "+instant.getBuyRate()+" BTC/GB\n[sell notes](command:sell) at "+instant.getSellRate()+" BTC/GB\nor [set your price](command:set price).");
		});
	});

	eventBus.on('text', function(from_address, text){
		text = text.trim();
		var lc_text = text.toLowerCase();
		
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
			
			if (lc_text === 'buy'){
				device.sendMessageToDevice(from_address, 'text', "Buying at "+instant.getBuyRate()+" BTC/MN.  Please let me know your note address (just click \"...\" button and select \"Insert my address\").");
				updateCurrentPrice(from_address, 'buy', null);
				updateState(from_address, 'waiting_for_trustnote_address');
				return;
			}
			if (lc_text === 'rates' || lc_text === 'rate'){
				device.sendMessageToDevice(from_address, 'text', "You can:\n[buy notes](command:buy) at "+instant.getBuyRate()+" BTC/MN\n[sell notes](command:sell) at "+instant.getSellRate()+" BTC/MN\nor [set your price](command:set price).");
				return;
			}
			if (lc_text === 'orders' || lc_text === 'book'){
				var and_device = (lc_text === 'book') ? '' : ' AND device_address=? ';
				var params = [];
				if (lc_text === 'orders')
					params.push(from_address, from_address);
				db.query(
					"SELECT price, 'buy' AS order_type, ROUND(SUM(satoshi_amount)/1e8/price, 9) AS total \n\
					FROM note_buyer_orders WHERE is_active=1 "+and_device+" \n\
					GROUP BY price \n\
					ORDER BY price DESC",
					params,
					function(rows){
						var arrLines = rows.map(row => "At "+row.price+" BTC/GB "+row.order_type+" vol. "+row.total+" GB");
						if (lc_text === 'book'){
							let firstBuyIndex = rows.findIndex(row => { return (row.order_type === 'buy'); });
							if (firstBuyIndex >= 0)
								arrLines.splice(firstBuyIndex, 0, '');
						}
						device.sendMessageToDevice(from_address, 'text', arrLines.join("\n") || "No orders at this time.");
					}
				);
				return;
			}
			if (lc_text === 'help')
				return device.sendMessageToDevice(from_address, 'text', "List of commands:\n[book](command:book): see the order book;\n[orders](command:orders): see your orders;\n[rates](command:rates): see buy and sell rates for instant exchange;\n[buy](command:buy): buy at instant rate;\n[sell](command:sell): sell at instant rate;\n[set price](command:set price): see suggested buy and sell prices;\nbuy at <price>: add a limit buy order at <price> or change the price of the existing buy orders;\nsell at <price>: add a limit sell order at <price> or change the price of the existing sell orders.");
			
			var bSetNewPrice = false;
			var arrMatches = lc_text.match(/(buy|sell) at ([\d.]+)/);
			if (arrMatches){
				var order_type = arrMatches[1];
				var price = parseFloat(arrMatches[2]);
				if (price){
					readCurrentOrderPrice(from_address, order_type, function(best_price){
						/*if (best_price){
							if (order_type === 'buy' && price < best_price)
								return device.sendMessageToDevice(from_address, 'text', "Buy price of existing orders can only be increased");
							if (order_type === 'sell' && price > best_price)
								return device.sendMessageToDevice(from_address, 'text', "Sell price of existing orders can only be decreased");
						}*/
						updateCurrentPrice(from_address, order_type, price);
						var response = (order_type === 'buy' ? 'Buying' : 'Selling')+' at '+price+' BTC/GB.';
						if (!best_price){
							response += '.\n' + (order_type === 'buy' ? "Please let me know your note address (just click \"...\" button and select \"Insert my address\")." : "Please let me know your Bitcoin address.");
							updateState(from_address, (order_type === 'buy') ? 'waiting_for_note_address' : 'waiting_for_bitcoin_address');
						}
						device.sendMessageToDevice(from_address, 'text', response);
					});
					bSetNewPrice = true;
				}
			}
			
			var arrMatches = text.match(/\b([A-Z2-7]{32})\b/);
			var bValidnoteAddress = (arrMatches && ValidationUtils.isValidAddress(arrMatches[1]));
			if (bValidnoteAddress){ // new BB address: create or update binding
				var out_note_address = arrMatches[1];
				assignOrReadDestinationBitcoinAddress(from_address, out_note_address, function(to_bitcoin_address){
					readCurrentPrices(from_address, function(buy_price, sell_price){
						var will_do_text = buy_price 
							? 'Your bitcoins will be added to the [book](command:book) at '+buy_price+' BTC/GB when the payment has at least '+MIN_CONFIRMATIONS+' confirmations.  You\'ll be able to change the price at any time by typing "buy at <new price>".' 
							: "Your bitcoins will be exchanged when the payment has at least "+MIN_CONFIRMATIONS+" confirmations, at the rate actual for that time, which may differ from the current rate ("+instant.getBuyRate()+" BTC/GB).";
						var maximum_text = buy_price ? "" : "maximum amount is "+instant.MAX_BTC+" BTC,";
						device.sendMessageToDevice(from_address, 'text', "Got it, you'll receive your notes to "+out_note_address+".  Now please pay BTC to "+to_bitcoin_address+".  We'll exchange as much as you pay, but the "+maximum_text+" minimum is "+(MIN_SATOSHIS/1e8)+" BTC (if you send less, it'll be considered a donation).  "+will_do_text);
					});
					updateState(from_address, 'waiting_for_payment');
					exchangeService.bus.subscribe('bitcoind/addresstxid', [to_bitcoin_address]);
				});
				return;
			}
			else if (state === 'waiting_for_trustnote_address' && !bSetNewPrice)
				return device.sendMessageToDevice(from_address, 'text', "This doesn't look like a valid note address.  Please click \"...\" button at the bottom of the screen and select \"Insert my address\", then hit \"Send\" button.");
			
			if (bSetNewPrice)
				return;
			
			switch(state){
				case 'greeting':
					device.sendMessageToDevice(from_address, 'text', "To start an exchange, see the current [rates](command:rates) or [set your price](command:set price).");
					break;
					
				case 'waiting_for_payment':
					device.sendMessageToDevice(from_address, 'text', "Waiting for your payment.  If you want to start another exchange, see the current [rates](command:rates) or [set your price](command:set price).");
					break;

				case 'waiting_for_confirmations':
					device.sendMessageToDevice(from_address, 'text', "Received your payment and waiting that it is confirmed.");
					break;
					
				case 'done':
					device.sendMessageToDevice(from_address, 'text', "If you want to start another exchange, see the current [rates](command:rates) or [set your price](command:set price).");
					break;
					
				default:
					throw Error("unknown state: "+state);
			}
		});
	});
	
	
	function handleNewTransaction(txid, to_bitcoin_address){
		exchangeService.node.services.bitcoind.getDetailedTransaction(txid, function(err, tx) {
			if (err)
				throw Error("getDetailedTransaction failed: "+err);
			var height = (tx.height === -1) ? null : tx.height;
			readCurrentHeight(function(currentHeight){
				var count_confirmations = height ? (currentHeight - height + 1) : 0;
				console.log("tx:", JSON.stringify(tx));
				console.log('tx inspect: '+require('util').inspect(tx, {depth:null}));
				if (txid !== tx.hash)
					throw Error(txid+"!=="+tx.hash);
				var received_satoshis = 0;
				for (var i = 0; i < tx.outputs.length; i++) {
					var output_bitcoin_address = tx.outputs[i].address;
					var satoshis = tx.outputs[i].satoshis;
					console.log("output address:", output_bitcoin_address);
					if (output_bitcoin_address === to_bitcoin_address)
						received_satoshis += satoshis;
				}
				// we also receive this event when the subscribed address is among inputs
				if (received_satoshis === 0)
					return console.log("to address "+to_bitcoin_address+" not found among outputs");
				//	throw Error("to address not found among outputs");
				db.query(
					"SELECT note_buyer_bindings.device_address, note_buyer_binding_id, buy_price \n\
					FROM note_buyer_bindings LEFT JOIN current_prices USING(device_address) \n\
					WHERE to_bitcoin_address=?",
					[to_bitcoin_address],
					function(rows){
						if (rows.length === 0)
							return console.log("unexpected payment");
						if (rows.length > 1)
							throw Error("more than 1 row per to btc address");
						var row = rows[0];
						if (received_satoshis < MIN_SATOSHIS){ // would burn our profit into BTC fees
							db.query(
								"INSERT "+db.getIgnore()+" INTO note_buyer_deposits \n\
								(note_buyer_binding_id, txid, satoshi_amount, fee_satoshi_amount, net_satoshi_amount, confirmation_date) \n\
								VALUES (?,?, ?,?,0, "+db.getNow()+")", 
								[row.note_buyer_binding_id, txid, received_satoshis, received_satoshis]
							);
							return device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(received_satoshis/1e8)+" BTC but it is too small and will not to be exchanged.");
						}
						db.query(
							"INSERT "+db.getIgnore()+" INTO note_buyer_deposits \n\
							(note_buyer_binding_id, txid, satoshi_amount, count_confirmations) VALUES(?,?,?,?)", 
							[row.note_buyer_binding_id, txid, received_satoshis, count_confirmations], 
							function(res){
								console.log('note_buyer_deposits res: '+JSON.stringify(res));
								if (!res.affectedRows)
									return console.log("duplicate transaction");
								if (count_confirmations >= MIN_CONFIRMATIONS)
									return exchangeBtcTonotesUnderLock(res.insertId);
								var do_what = row.buy_price ? "add the order to the [book](command:book)" : "exchange";
								device.sendMessageToDevice(row.device_address, 'text', "Received your payment of "+(received_satoshis/1e8)+" BTC but it is unconfirmed yet.  We'll "+do_what+" as soon as it gets at least "+MIN_CONFIRMATIONS+" confirmations.");
								updateState(row.device_address, 'waiting_for_confirmations');
							}
						);
					}
				);
			});
		});
	}
	
	exchangeService.bus.on('bitcoind/addresstxid', function(data) {
		console.log("bitcoind/addresstxid", data);
		var to_bitcoin_address = data.address;
		handleNewTransaction(data.txid, to_bitcoin_address);
	});
	
	exchangeService.node.services.bitcoind.on('tip', function(blockHash) {
		console.log('new tip '+blockHash);
		updateConfirmationCountOfRecentTransactionsAndExchange(MIN_CONFIRMATIONS);
	});
	
}


function ExchangeService(options) {
	this.node = options.node;
	EventEmitter.call(this, options);
	this.bus = this.node.openBus();
	
	initChat(this);
}
util.inherits(ExchangeService, EventEmitter);

ExchangeService.dependencies = ['bitcoind'];

ExchangeService.prototype.start = function(callback) {
	setImmediate(callback);
}

ExchangeService.prototype.stop = function(callback) {
	setImmediate(callback);
}

ExchangeService.prototype.getAPIMethods = function() {
	return [];
};

ExchangeService.prototype.getPublishEvents = function() {
	return [];
};

module.exports = ExchangeService;
