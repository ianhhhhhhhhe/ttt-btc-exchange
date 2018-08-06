/*jslint node: true */
'use strict';
var bitcore = require('bitcore-lib');
var client = require('./bitcoin_client.js');
var notifications = require('./notifications.js');
var instant = require('./instant.js');
var conf = require('trustnote-common/conf.js');
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
const langs = ["cn", "en"]

var wallet;

function payToAddress(args, callback) {
	var address = args.address
	var amount = parseInt(args.amount)
	console.log('===payTo: ' + address + " amount: " + amount + '===')
	if(!ValidationUtils.isValidAddress(address)){
		return callback('Uncorrect Address')
	}
	var Wallet = require('trustnote-common/wallet.js');
	Wallet.readBalance(wallet, function(assocBalances){
		var note_balance = assocBalances['base'].stable;
		if(note_balance < amount) {
			return callback('Not Enough Fund')
		}
		createPayment.createPayment(address, amount, function(res){
			callback(res)
		})
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

function getBtcBalanceFromAddressOfTestnet(args, callback) {
	let address = args.address
	client.getReceivedByAddress(address, 2, function(res){
		callback(null, null, res)
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

function postTranferResult(device_address, ttt_address, to_bitcoin_address, invite_code, callback) {
	let url = `https://activity.trustnote.org/exchange-order/save-order.htm?currency=TTT&payment=BTC&toAddress=${to_bitcoin_address}&tttAddress=${ttt_address}&deviceAddress=${device_address}&inviteCode=${invite_code}`
	console.log(url)
	request({
		url: url,
		method: 'GET',
		headers:{
			"Origin": "https://activity.trustnote.org",
            "Referer": "https://activity.trustnote.org"
        }
	}, (error, response, body) => {
		if (error){
			return callback(error);
		} else if (response.statusCode != 200) {
			return callback(error, response.statusCode);
		}
		return callback(error, response.statusCode, body)
	})
}

function getTranferResult(args, callback) {
	let from_address = args.from_address
	let amount = args.amount
	let receipt = args.receipt
	let rate = args.rate
	console.log('getTransferResult'+from_address+amount+receipt)
	const device = require('trustnote-common/device')
	device.sendMessageToDevice(from_address, 'text', 'You paid '+ receipt +' BTC for ' + amount +' MN and the price is: '+ rate +' BTC/TTT. Please click "WALLET" to view the detail\n本次支付'+ receipt +'BTC，价格'+ rate +'BTC/TTT，兑换' + amount +'TTT')
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
			case '/getBtcBalanceFromTestnet':
				return getBtcBalanceFromAddressOfTestnet(args, function(error, status_code, body){
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
					if(JSON.stringify(res)== JSON.stringify('Not Enough Fund')) {
						content.code = 500
						content.msg = 'Not Enough Fund'
					} else if (JSON.stringify(res)==JSON.stringify('Uncorrect Address')) {
						content.code = 501
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
			console.log('POST'+data);
			const resopnse = JSON.parse(data)
			switch(path){
				case '/getTransferResult':
				    return getTranferResult(resopnse, function(res){
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
console.log('\n==================')
console.log('Server is running')
console.log('==================\n')

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
						unlock()
					handleBitcoinAddress(to_bitcoin_address);
				}
			);
		});
	})
}

function checkSolvency(){
	var Wallet = require('trustnote-common/wallet.js');
	Wallet.readBalance(wallet, function(assocBalances){
		var note_balance = assocBalances['base'].stable + assocBalances['base'].pending;
		if(note_balance <= 1000000) {
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
		updateState(from_address, 'greeting');
		// device.sendMessageToDevice(from_address, 'text', "Welcome to TTT Trader, the easiest way to buy TTT with Bitcoin. Please click '[BUY](command:BUY)' to proceed\n这里是BTC购买TTT的快捷入口，请点击[BUY](command:BUY)进行购买");
		device.sendMessageToDevice(from_address, 'text', "Welcome to TTT Trader, please choose your language:\n\n[English](command:en)\n[Chinese](command:cn)\n")
	});
});

eventBus.on('text', function(from_address, text){
	var device = require('trustnote-common/device');
	text = text.trim();
	var lc_text = text.toLowerCase();

	function getUserLang(from_address, callback) {
		db.query('select lang from states where device_address=?', [from_address], function(rows) {
			if (rows.length===0) {
				notifications.notifyAdmin('Someone\'s language is not stored')
				device.sendMessageToDevice(from_address, 'text', 'Please choose language first')
			}
			let lang = rows[0].lang
			callback(lang)
		})
	}

	if(langs.indexOf(lc_text) >= 0) {
		db.query("update set lang=? where device_address=?", [lc_text, from_address],() => {})
		return
	}

	if(lc_text == 'hello' || lc_text == "你好") {
		updateState(from_address, 'greeting');
		getUserLang(from_address, function(lang){
			switch(lang){
				case "cn":
					return device.sendMessageToDevice(from_address, 'text', '你好');
				default:
					return device.sendMessageToDevice(from_address, 'text', 'hello');
			}
		})
		return;
	}
	
	readCurrentState(from_address, function(state, invite_code){
		console.log('state='+state);
		
		if (lc_text === 'buy') {
			getUserLang(from_address, function(lang){
				switch(lang){
					case "cn":
						return device.sendMessageToDevice(from_address, 'text', "输入邀请码或点击[跳过](command:SKIP)继续");
					default:
						return device.sendMessageToDevice(from_address, 'text', "Please enter your invitation code or click [SKIP](command:SKIP) to continue.");
				}
			})
			return;
		}

		if (lc_text === 'skip') {
			updateInviteCode(from_address, null)
			instant.getBuyRate(function(rates, error){
				if(error) {
					return device.sendMessageToDevice(from_address, 'text', 'The system is being maintained， please try it later')
				}
				getUserLang(from_address, function(lang){
					switch(lang){
						case "cn":
							return device.sendMessageToDevice(from_address, 'text', "当前价格: "+ rates +"BTC/TTT（每十分钟更新）\n\n请发送TTT地址（点击\"…\"按钮，选择插入我的地址）");
						default:
							return device.sendMessageToDevice(from_address, 'text', "Current Rate: "+ rates +"BTC/TTT\n\nPlease send TTT address (just click \"…\" botton and select \"Insert my address\")");
					}
				})
			})
			return;
		}

		var arrMatches = text.match(/\b([a-zA-Z0-9]{6})\b/);
		if (arrMatches) {
			updateInviteCode(from_address, arrMatches[0])
			instant.getBuyRate(function(rates, error){
				if(error) {
					return device.sendMessageToDevice(from_address, 'text', 'The system is being maintained， please try it later')
				}
				getUserLang(from_address, function(lang){
					switch(lang){
						case "cn":
							return device.sendMessageToDevice(from_address, 'text', "当前价格: "+ rates +"BTC/TTT（每十分钟更新）\n\n请发送TTT地址（点击\"…\"按钮，选择插入我的地址）");
						default:
							return device.sendMessageToDevice(from_address, 'text', "Current Rate: "+ rates +"BTC/TTT\n\nPlease send TTT address (just click \"…\" botton and select \"Insert my address\")");
					}
				})
			})
			return;
		}
		
		var arrMatches = text.match(/\b([A-Z2-7]{32})\b/);
		var bValidnoteAddress = (arrMatches && ValidationUtils.isValidAddress(arrMatches[1]));
		if (bValidnoteAddress){ // new BB address: create or update binding
			var out_note_address = arrMatches[1];
			assignOrReadDestinationBitcoinAddress(from_address, out_note_address, function(to_bitcoin_address){
				instant.getBuyRate(function(buy_price, error){
					if(error) {
						return device.sendMessageToDevice(from_address, 'text', 'The system is being maintained， please try it later')
					}
					getUserLang(from_address, function(lang){
						switch(lang){
							case "cn":
								device.sendMessageToDevice(from_address, 'text', "支付BTC到该地址: "+to_bitcoin_address+"\n\nNote注意事项：\n1.按照实际支付的BTC金额兑换TTT；\n2.当前价格仅供参考，实时价格以BTC确认时的价格为准；\n3.每次兑换金额不小于0.001BTC，少于最低限额视为捐献；\n4.该地址只允许支付一次，多次支付将不予返还；");
								break;
							default:
								device.sendMessageToDevice(from_address, 'text', "Pay BTC to address: "+to_bitcoin_address+"\n\nNote：\n1.We will exchange as much as you pay；\n2.Your bitcoins will be exchanged when the payment has at least 2 confirmations, at the rate actual for that time, which may differ from the current rate；\n3.The minimum is 0.001 BTC.If you pay less, it'll be considered a donation；\n4.This is only one-off address, additional payments won't be refunded；");
								break;
						}
					})
				});
				updateState(from_address, 'waiting_for_payment');
				postTranferResult(from_address, out_note_address, to_bitcoin_address, invite_code, function(error, statusCode, body){
					if(error) throw Error(error)
					console.log('===POST===, statusCode: '+statusCode+' res: '+body)
				})
				// exchangeService.bus.subscribe('bitcoind/addresstxid', [to_bitcoin_address]);
			});
			return;
		}
		else if (state === 'waiting_for_trustnote_address'){
			getUserLang(from_address, function(lang){
				switch(lang){
					case "cn":
						return device.sendMessageToDevice(from_address, 'text', "地址不正确，请重新输入或点击[BUY](command:BUY)进行购买");
					default:
						return device.sendMessageToDevice(from_address, 'text', "Address form isn't correct. Re-enter or click [BUY](command:BUY) to try it again");
				}
			})
			return
		}

		getUserLang(from_address, function(lang){
			switch(lang){
				case "cn":
					return device.sendMessageToDevice(from_address, 'text', "错误信息，请重新输入或点击[BUY](command:BUY)进行购买");
				default:
					return device.sendMessageToDevice(from_address, 'text', "The information is not recognizable. Re-enter or click [BUY](command:BUY) to try it again");
			}
		})
	});
});

exports.postTranferResult = postTranferResult