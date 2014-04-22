'use strict';

var Promise = require('promise');
var util = require('util');
var assert = require('assert');
var crypto = require('crypto');
var querystring = require('querystring');
var Interval = require('./interval').Interval;
var ByteSize = require('./byte-size').ByteSize;
var db = require('./db');
var config = require('../config');

var sessionKey = new Buffer(config.session.key, 'base64');
var guestMaxAge = new Interval(config.session.guestMaxAge).seconds;
var userMaxAge = new Interval(config.session.userMaxAge).seconds;
var maximumFormSize = new ByteSize(config.maximumFormSize).bytes;

assert(sessionKey.length, 'session key shouldn’t be empty');
assert(maximumFormSize, 'maximum form size should be non-zero');

function sign(sessionId) {
	var hmac = crypto.createHmac('sha256', sessionKey);

	hmac.update(sessionId);

	return hmac.digest('base64');
}

function checkToken(token) {
	if (!token) {
		return {
			valid: false
		};
	}

	var separatorIndex = token.indexOf(':');
	var sessionId = token.substring(0, separatorIndex);
	var expectedDigest = token.substring(separatorIndex + 1);
	var valid = sign(sessionId) === expectedDigest;

	return {
		valid: valid,
		token: expectedDigest,
		sessionId: valid ? sessionId | 0 : null
	};
}

function createGuestToken(callback) {
	crypto.randomBytes(9, function (error, bytes) {
		if (error) {
			callback(error);
		} else {
			callback(null, 'g' + bytes.toString('base64'));
		}
	});
}

function createUserSession(userId, response) {
	return db.query('INSERT INTO sessions (owner) VALUES ($1) RETURNING id', [userId]).then(function (result) {
		var sessionId = result.rows[0].id;

		response.setHeader('Set-Cookie',
			util.format(
				't=%d:%s; Max-Age=%d; Path=/; Secure; HttpOnly',
				sessionId, sign('' + sessionId), userMaxAge
			)
		);
	});
}

function formData(request) {
	var expectedToken = request.token;

	return new Promise(function (resolve, reject) {
		var parts = [];
		var totalLength = 0;

		function addPart(part) {
			totalLength += part.length;

			if (totalLength > maximumFormSize) {
				request.removeListener('data', addPart);
				request.removeListener('end', parseFormData);

				reject({
					statusCode: 413,
					message: 'The submitted data exceeded the maximum allowed size.'
				});

				return;
			}

			parts.push(part);
		}

		function parseFormData() {
			var body = Buffer.concat(parts, totalLength).toString('utf8');
			var data = querystring.parse(body);

			if (data.token !== expectedToken) {
				reject({
					statusCode: 403,
					message: 'Your request was made with an unexpected token; please go back, refresh, and try again.'
				});

				return;
			}

			resolve(data);
		}

		request.on('data', addPart);
		request.on('end', parseFormData);
	});
}

function middleware(request, response, next) {
	function createNewToken() {
		createGuestToken(function (error, newToken) {
			if (error) {
				next(error);
				return;
			}

			request.token = newToken;

			response.setHeader('Set-Cookie',
				util.format(
					't=%s:%s; Max-Age=%d; Path=/; Secure; HttpOnly',
					newToken, sign(newToken), guestMaxAge
				)
			);

			next();
		});
	}

	var token = checkToken(request.cookies.t);

	if (!token.valid) {
		createNewToken();
		return;
	}

	request.token = token.token;

	if (!token.sessionId) {
		next();
		return;
	}

	db.query('SELECT sessions.owner, users.username FROM sessions INNER JOIN users ON users.id = sessions.owner WHERE sessions.id = $1', [token.sessionId]).then(
		function (result) {
			request.userId = result.rows[0].owner;
			request.username = result.rows[0].username;
			next();
		},
		next
	);
}

module.exports.middleware = middleware;
module.exports.createUserSession = createUserSession;
module.exports.formData = formData;