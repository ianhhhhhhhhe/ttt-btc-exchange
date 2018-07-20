CREATE TABLE states (
	device_address CHAR(33) NOT NULL PRIMARY KEY,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_update TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
	state VARCHAR(30) NOT NULL DEFAULT 'greeting',
	invite_code CHAR(32) NULL,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);

-- bindings

CREATE TABLE note_buyer_orders (
	note_buyer_binding_id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
	out_note_address CHAR(32) NOT NULL UNIQUE,
	to_bitcoin_address VARCHAR(34) NOT NULL UNIQUE,
	device_address CHAR(33) NOT NULL,
	creation_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (device_address) REFERENCES correspondent_devices(device_address)
);
