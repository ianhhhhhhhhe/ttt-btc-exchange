/*jslint node: true */
"use strict";

var request = require('request');
// var instant = require('./instant')
var conf = require('./conf.js');

var url = 'http://150.109.32.56:9000';

function getBtcBalance(api, callback){
	request({
        url: url + api,
        method: 'GET',
        }, function(error, response, body) {
		if (!error && response.statusCode == 200) {
            callback(body);
		} else {
            if (error){
                callback('', error);
            } else if (response.statusCode != 200) {
                callback('', error, response.statusCode);
            }
        }
	});
}

function postTranferResult(device_address, ttt_address, to_bitcoin_address, invite_code, callback) {
	let url = `https://testactivity.trustnote.org/exchange-order/save-order.htm?currency=TTT&payment=BTC&toAddress=${to_bitcoin_address}&tttAddress=${ttt_address}&deviceAddress=${device_address}&inviteCode=${invite_code}`
	console.log(url)
	request({
		url: url,
		method: 'POST',
		headers:{
			"Origin": "https://testactivity.trustnote.org",
            "Referer": "localhost"
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

getBtcBalance('/getBtcBalance?address=1AJbsFZ64EpEfS5UAjAfcUG8pH8Jn3rn1F', function(body){
    console.log(body)
})

postTranferResult('0JEMD6GQP4R7ETD6NRCZNGKNUMCXLNNFE', 'WM26JNVD4ZAP2HUVJ4CWA44DQS4PHFDD', 'mykgCQ5wed3p96BDYPg5uQY3JmZGYzDTF1', '00000000', (body) => {
    console.log(body)
})

// const rate_url = 'https://api.bit-z.pro/api_v1/ticker?coin=ttt_btc'; //exchange api

// function getBuyRate(callback){
// 	request.get(rate_url, function(error, response, body) {
// 		if (!error && response.statusCode == 200) {
// 			var res = JSON.parse(body)
// 			var buy = res.data.buy
// 			return callback(buy);
// 		} else {
// 			notifications.notifyAdmin('Cannot get ', rate_url)
// 		}
// 	});
// }

// getBuyRate(function(res) {
//     console.log(res)
// })