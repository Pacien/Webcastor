/*
 * This file is part of Webcastor <https://github.com/Pacien/Webcastor>.

 * Webcastor is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.

 * Webcastor is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.

 * You should have received a copy of the GNU General Public License
 * along with Webcastor.  If not, see <http://www.gnu.org/licenses/>.
 */

var imports = {
	http : require('http'),
	url : require('url'),

	express : require('express'),
	logfmt : require('logfmt'),
	bodyParser : require('body-parser'),
	hogan : require('hogan-express'),

	socketio : require('socket.io'),

	redis : require('redis'),

	passwordHash : require('password-hash'),
	uuid : require('node-uuid'),
};

var params = {
	database : {
		persistent : process.env.REDISCLOUD_URL !== undefined && process.env.REDISCLOUD_URL !== null,
		server : process.env.REDISCLOUD_URL,
	},

	server : {
		port : (process.env.PORT !== undefined) ? process.env.PORT : '8080',
	},

	messageSizeLimit : 8000,
};

var VolatileKeyValueStore = {
	create : function() {
		var self = Object.create(this);
		this.store = {};
		return self;
	},

	set : function(key, value) {
		this.store[key] = value;
	},

	get : function(key, callback) {
		var value = this.store[key];
		callback(null, value);
	},
};

var Channel = {
	create : function(password) {
		var uniqueName = this.generateUniqueName();
		this.open(uniqueName, password);
		return uniqueName;
	},

	open : function(name, password) {
		var hashedPassword;
		if (password === '') {
			hashedPassword = 'none';
		} else {
			hashedPassword = imports.passwordHash.generate(password);
		}
		Server.db.set(name, hashedPassword);
	},

	generateUniqueName : function() {
		return imports.uuid.v1();
	},

	getPassword : function(name, callback) {
		Server.db.get(name, function(err, hashedPassword) {
			callback(hashedPassword);
		});
	},
};

var Server = {
	init : function() {
		if (params.database.persistent) {
			this.db = this.connectToDb();
		} else {
			this.db = VolatileKeyValueStore.create();
		}

		this.app = this.createApp();
		this.server = imports.http.createServer(this.app);
		this.io = imports.socketio.listen(this.server);

		this.addHandlers(this.app, this.io);

		this.server.listen(params.server.port);
	},

	createApp : function() {
		var app = imports.express();

		app.use(imports.logfmt.requestLogger());
		app.use(imports.bodyParser.json());
		app.use(imports.bodyParser.urlencoded({
			extended : true,
		}));
		app.set('view engine', 'html');
		app.set('layout', 'layout');
		app.enable('view cache');
		app.engine('html', imports.hogan);

		return app;
	},

	connectToDb : function() {
		var redisURL = imports.url.parse(params.database.server);
		console.log(redisURL);
		var db = imports.redis.createClient(redisURL.port, redisURL.hostname, {
			no_ready_check : true
		});
		db.auth(redisURL.auth.split(':')[1]);
		db.on('error', function(err) {
			console.log('Redis error encountered: ', err);
		});

		return db;
	},

	addHandlers : function(app, io) {
		app.get('/client', function(req, res) {
			res.render('client');
		});

		app.get('/', function(req, res) {
			res.render('home');
		});

		app.post('/', function(req, res) {
			var password = req.body.password !== undefined ? req.body.password : '';

			var channelName = Channel.create(password);

			console.log('Created new channel ' + channelName);

			res.render('channel', {
				channel : channelName,
				url : 'https://' + req.hostname + '/',
			});
		});

		io.sockets.on('connection', function(socket) {
			var query = imports.url.parse(socket.handshake.url, true).query;
			var channel = query.channel;
			var password = query.password;

			console.log('Incomming connection on ' + channel);
			Server.handleSocket(socket, channel, password);
		});
	},

	handleSocket : function(socket, channel, password) {
		Channel.getPassword(channel, function(hashedPassword) {

			if (hashedPassword === null) {
				console.log('Client tried to join an unknown channel');
				socket.emit('unknown_channel');
				return;
			}

			socket.join(channel);

			if (password === undefined) {

				console.log('Client joined ' + channel);

			} else {

				if (hashedPassword === 'none' || imports.passwordHash.verify(password, hashedPassword)) {
					console.log('Broadcaster joined ' + channel);
					socket.emit("authenticated");

					socket.on('message', function(event) {
						Server.broadcast(socket, channel, event);
					});
				} else {
					console.log('Authentication error on channel ' + channel);
					socket.emit('authentication_error');
				}

			}

		});
	},

	broadcast : function(socket, channel, event) {
		var JSONmessage = JSON.stringify(event);

		var messageSize = encodeURI(JSONmessage).split(/%..|./).length - 1;
		if (messageSize > params.messageSizeLimit) {
			console.log('Not broadcasting ' + JSONmessage + ' (' + messageSize + ' bytes)');
			return;
		}

		console.log('Broadcasting ' + JSONmessage + ' (' + messageSize + ' bytes) on channel ' + channel);
		socket.broadcast.to(channel).send(event);
	},
};

Server.init();
