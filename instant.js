/*jslint node: true */
'use strict';
var async = require('async');
var notifications = require('./notifications.js');
var settlement = require('./settlement.js');
var book = require('./book.js');
var db = require('trustnote-common/db.js');
var mutex = require('trustnote-common/mutex.js');
var eventBus = require('trustnote-common/event_bus.js');

let request = require('request')

const INSTANT_MARGIN = 0.02;

const MAX_BTC = 0.2;
const MAX_GB = 1;

// from customer's perspective, BTC/GB
const SAFE_BUY_RATE = 0.04;
const SAFE_SELL_RATE = 0.01;

// from customer's perspective, BTC/GB
var buy_rate = SAFE_BUY_RATE;  // higher
var sell_rate = SAFE_SELL_RATE; // lower
const rate_url = 'https://api.bit-z.com/api_v1/ticker?coin=ttt_btc'; //exchange api

function getBuyRate(callback){
	return callback(0.000007);
	request.get(rate_url, function(error, response, body) {
		if (!error && response.statusCode == 200) {
			return callback(JSON.stringify(body));
		} else {
			notifications.notifyAdmin('Cannot get ', rate_url)
		}
	});
}

function handleInstantBuyOrder(conn, note_buyer_deposit_id, satoshi_amount, device_address, onDone){
	var note_amount = book.satoshis2notes(satoshi_amount, buy_rate);
	conn.query("SELECT * FROM note_seller_orders WHERE is_active=1 AND price<=? ORDER BY price ASC, last_update ASC", [buy_rate], function(seller_rows){
		var total_notes = seller_rows.reduce(function(acc, seller_order){ return acc + seller_order.note_amount; }, 0);
		if (total_notes < note_amount){
			book.insertBuyerOrder(conn, note_buyer_deposit_id, satoshi_amount, device_address, buy_rate, function(){
				var device = require('trustnote-common/device.js');
				device.sendMessageToDevice(device_address, 'text', "Your payment is now confirmed but there's not enough liquidity to complete the exchange.  We'll exchange your bitcoins as soon as possible.");
			});
			return onDone();
		}
		book.finishBuyerDeposit(conn, note_buyer_deposit_id, 0, satoshi_amount, function(){
			conn.query(
				"INSERT INTO note_buyer_instant_deals (note_buyer_deposit_id, satoshi_amount, note_amount, price) VALUES (?,?,?,?)", 
				[note_buyer_deposit_id, satoshi_amount, note_amount, buy_rate],
				function(res){
					var note_buyer_instant_deal_id = res.insertId;
					var remaining_note_amount = note_amount;
					async.eachSeries(
						seller_rows,
						function(seller_order, cb){
							var execution_price = seller_order.price;
							var bFull = (remaining_note_amount >= seller_order.note_amount); // full execution of the book order
							var bDone = (remaining_note_amount <= seller_order.note_amount);
							var transacted_notes = bFull ? seller_order.note_amount : remaining_note_amount;
							var transacted_satoshis = book.notes2satoshis(transacted_notes, execution_price);
							if (transacted_satoshis === 0)
								throw Error("transacted_satoshis=0");
							var seller_order_props = {
								execution_price: execution_price, 
								transacted_satoshis: transacted_satoshis, 
								transacted_notes: transacted_notes, 
								note_buyer_instant_deal_id: note_buyer_instant_deal_id
							};
							book.markSellerOrderMatched(conn, seller_order.note_seller_order_id, seller_order_props, function(){
								remaining_note_amount -= transacted_notes;
								if (bFull)
									return bDone ? cb('done') : cb();
								book.insertRemainderSellerOrder(conn, seller_order, transacted_notes, function(){
									bDone ? cb('done') : cb();
								});
							});
						},
						function(err){
							if (!err)
								throw Error('seller rows not interrupted');
							onDone();
						}
					);
				}
			);
		});
	});
}


function updateInstantRates(){
	db.query("SELECT price, satoshi_amount FROM note_buyer_orders WHERE is_active=1 ORDER BY price DESC, last_update ASC", function(rows){
		var accumulated_satoshis = 0;
		var bFound = false;
		var price;
		var min_price = SAFE_SELL_RATE;
		for (var i=0; i<rows.length; i++){
			price = rows[i].price;
			if (price < min_price)
				min_price = price;
			accumulated_satoshis += rows[i].satoshi_amount;
			if (accumulated_satoshis >= MAX_BTC*1e8){
				bFound = true;
				break;
			}
		}
		if (!bFound){
			sell_rate = min_price;
			return notifications.notifyAdmin('not enough buy-side liquidity');
		}
		sell_rate = Math.round(price/(1+INSTANT_MARGIN)*10000)/10000;
	});
}

eventBus.on('book_changed', updateInstantRates);

exports.MAX_BTC = MAX_BTC;
exports.MAX_GB = MAX_GB;
exports.getBuyRate = getBuyRate;
exports.handleInstantBuyOrder = handleInstantBuyOrder;
exports.updateInstantRates = updateInstantRates;

