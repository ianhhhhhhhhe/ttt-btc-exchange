bitcoin = require('bitcoin')

var client = new bitcoin.Client({
    host: 'localhost',
    port: 8332,
    user: 'username',
    pass: 'password',
    timeout: 30000
})

client.getBalance('*', 6, function(err, balance, resHeaders){
    if (err) return console.log(err);
    console.log('Balance:', balance);
})