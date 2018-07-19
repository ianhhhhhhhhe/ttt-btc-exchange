/*jslint node: true */
'use strict';
var util = require('util');
var async = require('async');
var client = require('./bitcoin_client.js');
var db = require('trustnote-common/db.js');
var mutex = require('trustnote-common/mutex.js');
var eventBus = require('trustnote-common/event_bus.js');
var headlessWallet = require('trustnote-headless');
var notifications = require('./notifications.js');




// amount in BTC
function sendBtc(amount, address, onDone){
	client.sendToAddress(address, amount, function(err, txid, resHeaders) {
		console.log('bitcoin sendToAddress '+address+', amount '+amount+', txid '+txid+', err '+err);
		if (err && err+'' === 'Error: Transaction amount too small'){
			err = null;
			txid = 'too small';
		}
		if (err)
			return onDone(err);
		onDone(null, txid);
	});
}

function settleInstantBtc(){
	mutex.lock(['settle_btc'], function(unlock){
		db.query(
			"SELECT satoshi_amount, note_seller_instant_deals.note_amount, out_bitcoin_address, device_address, note_seller_instant_deal_id \n\
			FROM note_seller_instant_deals \n\
			JOIN note_seller_deposits USING(note_seller_deposit_id) \n\
			JOIN note_seller_bindings USING(note_seller_binding_id) \n\
			WHERE execution_date IS NULL",
			function(rows){
				async.eachSeries(
					rows,
					function(row, cb){
						var txid;
						db.executeInTransaction(function(conn, onTransactionDone){
							conn.query(
								"INSERT INTO note_seller_instant_deal_executions (note_seller_instant_deal_id) VALUES(?)", 
								[row.note_seller_instant_deal_id], 
								function(){
									sendBtc(row.satoshi_amount/1e8, row.out_bitcoin_address, function(err, _txid){
										if (err){
											notifications.notifyAdminAboutFailedPayment("sending instant "+(row.satoshi_amount/1e8)+" BTC to "+row.out_bitcoin_address+": "+err);
											return onTransactionDone(err); // would rollback
										}
										txid = _txid;
										console.log('sent instant payment '+row.note_seller_instant_deal_id+': '+(row.satoshi_amount/1e8)+' BTC in exchange for '+row.note_amount+' notes');
										onTransactionDone(); // executions will be committed now
									});
								}
							);
						}, function(err){
							if (err)
								return cb();
							if (!txid)
								throw Error('no txid');
							db.query(
								"UPDATE note_seller_instant_deals SET execution_date="+db.getNow()+", txid=? WHERE note_seller_instant_deal_id=?", 
								[txid, row.note_seller_instant_deal_id], 
								function(){
									var device = require('trustnote-common/device.js');
									device.sendMessageToDevice(row.device_address, 'text', "Sent "+(row.satoshi_amount/1e8)+" BTC.  Exchange complete, thank you for using our services!");
									cb();
								}
							);
						});
					},
					unlock
				);
			}
		);
	});
}

function settleBookBtc(){
	mutex.lock(['settle_btc'], function(unlock){
		db.query(
			"SELECT satoshi_amount, sold_note_amount, out_bitcoin_address, note_seller_orders.device_address, note_seller_order_id \n\
			FROM note_seller_orders \n\
			JOIN note_seller_deposits USING(note_seller_deposit_id) \n\
			JOIN note_seller_bindings USING(note_seller_binding_id) \n\
			WHERE is_active=0 AND execution_date IS NULL",
			function(rows){
				async.eachSeries(
					rows,
					function(row, cb){
						var txid;
						db.executeInTransaction(function(conn, onTransactionDone){
							conn.query(
								"INSERT INTO note_seller_order_executions (note_seller_order_id) VALUES(?)", 
								[row.note_seller_order_id], 
								function(){
									sendBtc(row.satoshi_amount/1e8, row.out_bitcoin_address, function(err, _txid){
										if (err){
											notifications.notifyAdminAboutFailedPayment("sending book "+(row.satoshi_amount/1e8)+" BTC to "+row.out_bitcoin_address+": "+err);
											return onTransactionDone(err); // would rollback
										}
										txid = _txid;
										console.log('sent book payment '+row.note_seller_order_id+': '+(row.satoshi_amount/1e8)+' BTC in exchange for '+row.sold_note_amount+' notes');
										onTransactionDone(); // executions will be committed now
									});
								}
							);
						}, function(err){
							if (err)
								return cb();
							if (!txid)
								throw Error('no txid');
							db.query(
								"UPDATE note_seller_orders SET execution_date="+db.getNow()+", txid=? WHERE note_seller_order_id=?", 
								[txid, row.note_seller_order_id], 
								function(){
									var device = require('trustnote-common/device.js');
									device.sendMessageToDevice(row.device_address, 'text', "Sent "+(row.satoshi_amount/1e8)+" BTC.  See in the list of [orders](command:orders) if any of your orders are still pending");
									cb();
								}
							);
						});
					},
					unlock
				);
			}
		);
	});
}

function settleInstantnotes(){
	mutex.lock(['settle_notes'], function(unlock){
		db.query(
			"SELECT note_buyer_instant_deals.satoshi_amount, note_amount, out_note_address, device_address, note_buyer_instant_deal_id \n\
			FROM note_buyer_instant_deals \n\
			JOIN note_buyer_deposits USING(note_buyer_deposit_id) \n\
			JOIN note_buyer_bindings USING(note_buyer_binding_id) \n\
			WHERE execution_date IS NULL",
			function(rows){
				async.eachSeries(
					rows,
					function(row, cb){
						headlessWallet.issueChangeAddressAndSendPayment(null, row.note_amount, row.out_note_address, row.device_address, function(err, unit){
							if (err){
								notifications.notifyAdminAboutFailedPayment(err);
								return cb();
							}
							console.log('sent payment '+row.note_buyer_instant_deal_id+': '+row.note_amount+' notes in exchange for '+(row.satoshi_amount/1e8)+' BTC');
							db.query(
								"INSERT INTO note_buyer_instant_deal_executions (note_buyer_instant_deal_id) VALUES(?)", 
								[row.note_buyer_instant_deal_id], 
								function(){
									db.query(
										"UPDATE note_buyer_instant_deals SET execution_date="+db.getNow()+", unit=? WHERE note_buyer_instant_deal_id=?", 
										[unit, row.note_buyer_instant_deal_id], 
										function(){
											var device = require('trustnote-common/device.js');
											device.sendMessageToDevice(row.device_address, 'text', "Sent "+(row.note_amount/1e9)+" GB.  Exchange complete, thank you for using our services!");
											cb();
										}
									);
								}
							);
						});
					},
					unlock
				);
			}
		);
	});
}

function settleBooknotes(){
	mutex.lock(['settle_notes'], function(unlock){
		db.query(
			"SELECT sold_satoshi_amount, note_amount, out_note_address, note_buyer_bindings.device_address, note_buyer_order_id \n\
			FROM note_buyer_orders \n\
			JOIN note_buyer_deposits USING(note_buyer_deposit_id) \n\
			JOIN note_buyer_bindings USING(note_buyer_binding_id) \n\
			WHERE is_active=0 AND execution_date IS NULL",
			function(rows){
				async.eachSeries(
					rows,
					function(row, cb){
						headlessWallet.issueChangeAddressAndSendPayment(null, row.note_amount, row.out_note_address, row.device_address, function(err, unit){
							if (err){
								notifications.notifyAdminAboutFailedPayment(err);
								return cb();
							}
							console.log('sent payment '+row.note_buyer_order_id+': '+row.note_amount+' notes in exchange for '+(row.sold_satoshi_amount/1e8)+' BTC');
							db.query("INSERT INTO note_buyer_order_executions (note_buyer_order_id) VALUES(?)", [row.note_buyer_order_id], function(){
								db.query(
									"UPDATE note_buyer_orders SET execution_date="+db.getNow()+", unit=? WHERE note_buyer_order_id=?", 
									[unit, row.note_buyer_order_id], 
									function(){
										var device = require('trustnote-common/device.js');
										device.sendMessageToDevice(row.device_address, 'text', "Sent "+(row.note_amount/1e9)+" GB.  See in the list of [orders](command:orders) if any of your orders are still pending");
										cb();
									}
								);
							});
						});
					},
					unlock
				);
			}
		);
	});
}


exports.settleInstantBtc = settleInstantBtc;
exports.settleBookBtc = settleBookBtc;
exports.settleInstantnotes = settleInstantnotes;
exports.settleBooknotes = settleBooknotes;
