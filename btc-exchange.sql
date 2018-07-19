CREATE TABLE states (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_update TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	state VARCHAR(30) NOT NULL DEFAULT 'greeting',
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);


CREATE TABLE current_prices (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	buy_price DECIMAL(20, 10) NULL,
	sell_price DECIMAL(20, 10) NULL,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

-- bindings

CREATE TABLE note_buyer_bindings (
	note_buyer_binding_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	out_note_address CHAR(32) NOT NULL UNIQUE,
	to_bitcoin_address VARCHAR(34) NOT NULL UNIQUE,
	device_address CHAR(33) NOT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

-- deposits

CREATE TABLE note_buyer_deposits (
	note_buyer_deposit_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	note_buyer_binding_id INTEGER NOT NULL,
	count_confirmations INT NOT NULL DEFAULT 0,
	txid CHAR(64) NOT NULL,
	satoshi_amount INT NOT NULL,
	fee_satoshi_amount INT NULL,  -- filled wnen confirmed
	net_satoshi_amount INT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	confirmation_date TIMESTAMP NULL,
	UNIQUE (txid, note_buyer_binding_id),
	FOREIGN KEY (note_buyer_binding_id) REFERENCES note_buyer_bindings(note_buyer_binding_id)
);
CREATE INDEX byBuyerDepositsConfirmation ON note_buyer_deposits(confirmation_date);

-- instant orders

-- customer gets quoted price and is instantly filled
-- the operator realays the deal to the book on his own behalf by buying or selling against pending book orders, with a margin

CREATE TABLE note_buyer_instant_deals (
	note_buyer_instant_deal_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	note_buyer_deposit_id INTEGER NOT NULL UNIQUE,
	unit CHAR(44) NULL,
	satoshi_amount INT NOT NULL,
	note_amount INT NOT NULL,
	price DOUBLE NOT NULL,
	match_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	execution_date TIMESTAMP NULL,
	FOREIGN KEY (note_buyer_deposit_id) REFERENCES note_buyer_deposits(note_buyer_deposit_id),
	FOREIGN KEY (unit) REFERENCES units(unit)
);
CREATE INDEX byBuyerInstantDealsExecution ON note_buyer_instant_deals(execution_date);

CREATE TABLE note_buyer_instant_deal_executions (
	note_buyer_instant_deal_id INTEGER NOT NULL PRIMARY KEY,
	execution_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (note_buyer_instant_deal_id) REFERENCES note_buyer_instant_deals(note_buyer_instant_deal_id)
);

-- book orders

CREATE TABLE note_buyer_orders (
	note_buyer_order_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	note_buyer_deposit_id INTEGER NOT NULL,
	prev_note_buyer_order_id INTEGER NULL, -- after partial execution
	device_address CHAR(33) NOT NULL,
	is_active TINYINT NOT NULL DEFAULT 1,
	satoshi_amount INT NOT NULL,
	price DECIMAL(20, 10) NOT NULL,
	unit CHAR(44) NULL,
	execution_price DECIMAL(20, 10) NULL,
	sold_satoshi_amount INT NULL,
	note_amount INT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_update TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	match_date TIMESTAMP NULL,
	execution_date TIMESTAMP NULL,
	note_seller_instant_deal_id INT NULL, -- if executed against instant order
	FOREIGN KEY (unit) REFERENCES units(unit),
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address),
	FOREIGN KEY (note_buyer_deposit_id) REFERENCES note_buyer_deposits(note_buyer_deposit_id),
	FOREIGN KEY (prev_note_buyer_order_id) REFERENCES note_buyer_orders(note_buyer_order_id),
	FOREIGN KEY (note_seller_instant_deal_id) REFERENCES note_seller_instant_deals(note_seller_instant_deal_id)
);
CREATE INDEX byBuyerOrdersDevice ON note_buyer_orders(device_address);
CREATE INDEX byBuyerOrdersActivePrice ON note_buyer_orders(is_active, price);
CREATE INDEX byBuyerOrdersActiveExecuted ON note_buyer_orders(is_active, execution_date);

-- if executed against book order
ALTER TABLE note_buyer_orders ADD COLUMN opposite_note_seller_order_id INTEGER NULL REFERENCES note_seller_orders(note_seller_order_id); -- opposite order


CREATE TABLE note_buyer_order_executions (
	note_buyer_order_id INTEGER NOT NULL PRIMARY KEY,
	execution_date TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (note_buyer_order_id) REFERENCES note_buyer_orders(note_buyer_order_id)
);




