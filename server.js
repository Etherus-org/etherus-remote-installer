const handleCommand = require('./index').InstallerWS.handleCommand;
const tmp = require('tmp');
const fs = require('fs');
const express = require('express');
const app = express();
const expressWs = require('express-ws')(app);
const WSOPEN = require('ws').OPEN;

app.use(function (req, res, next) {
	console.log('middleware');
	req.testing = 'testing';
	return next();
});

app.get('/', function(req, res, next){
	console.log('get route', req.testing);
	res.end();
});

app.ws('/', function(ws, req) {
	ws.on('message', function(msg) {
		console.log(msg);
		handleMessage(ws, msg);
	});
	prepareWs(ws);
	console.log('socket', req.testing);
});

app.listen(3000);

function prepareWs(ws, cfg){
	let safeOut = cfg && cfg.safeOut || function(){};
	ws.sendSafe = function(data) {
		if (this.readyState !== WSOPEN) { 
			safeOut(data); 
		} else {
			this.send(data);
		}
	}
	return ws;
}

function handleMessage(ws, message) {
	handleCommandMessage(
		(msg, data)=>ws.sendSafe(JSON.stringify({
			msg: msg,
			data: data
		})),
		(err, data)=>ws.sendSafe(JSON.stringify({
			err: err,
			data: data
		})),
		message, {
			branch: 'master',
			scriptArgs: 'MODE=remote'
		})
	.then(
		(result)=>{
			ws.close();
			console.log("Closing WS result: "+(result?'success':'failure'));
		},
		(err)=>{
			ws.sendSafe(JSON.stringify({
				err: err
			}));
			ws.close();
			console.log("Closing WS error: "+err);
		});
}

function handleCommandMessage(stdout, stderr, commandMessage, options) {
	try{
		let cmd = JSON.parse(commandMessage);
		return setupTempFile((out, cleanup, logPath) => {
			console.log('Installation log for '+cmd.data.ssh.username+'@'+cmd.data.ssh.host+':'+cmd.data.ssh.port+'> '+logPath);
			cmd.data.out=out;
			cmd.data.outCleanup=cleanup;
			cmd.data.installationToken=logPath.replace(/.*install-(.*).log/, '$1');
			stdout('Starting installation '+cmd.data.installationToken);
			return handleCommand(
				stdout,
				stderr,
				cmd.command,
				cmd.data,
				options);
		});
		
	} catch(err) {
		console.log(err);
		if(err instanceof SyntaxError) {
			return Promise.reject(err.message);
		} else {
			return Promise.reject('Internal Error');
		}
	}
}

function setupTempFile(callback){
	return new Promise((accept,reject)=>
		tmp.file({
			mode: 0644,
			prefix: 'install-',
			postfix: '.log',
			keep: true
		},
		(err, tmpPath, fd, cleanupCallback) => {
			if (err) throw err;
			let ws = fs.createWriteStream(null, {fd: fd});
			let out=function(out) {
				ws.write(out+'\n');
			};
			let outCleanup=(cleanup)=>{
				if(cleanup) {
					ws.on('close', () => {
						cleanupCallback();
					});
				}
				ws.close();
			};
			callback(out, outCleanup, tmpPath).then(
				(result)=>accept(result),
				(err)=>reject(err));
		}));
}
