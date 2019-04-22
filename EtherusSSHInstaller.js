const Client = require('ssh2').Client;
const inherits = require('util').inherits;
const checkNodeAlive = require('./checkNodeAlive');

const Constants = Object.freeze({   
	EventPrefix: 'etherus-remote-installer.'
});

'use strict'

//stream.stdin.write(require('fs').readFileSync('../../Testrun/out/centos_7_install_bootstrap'));

function EtherusSSHInstaller(options) {
	if (!(this instanceof EtherusSSHInstaller))
		return new EtherusSSHInstaller();

	Client.call(this);

	this.config = {
		out: undefined,
		outCleanup: undefined,
		install: true,
		stopService: false,
		startService: false,
		wipeData: false,
		checkHealth: true,
		listValidatorKeys: false,
		checkHealthRetryCount: 60,
		checkHealthRetryDelay: 5000,
		checkService: true,
		checkSystem: true,
		ssh: undefined
	};

	this.branch = options && options.branch || 'master'
	this.scriptArgs = options && options.scriptArgs || ''
	this.privateValidatorKeys = options && options.privateValidatorKeys || ''
}
inherits(EtherusSSHInstaller, Client);

function isFunction(arg) {
	return arg instanceof Function && arg;
}

function NOP(){}

Client.prototype.install = function(cfg) {
	let self = __getConfig(this, cfg);
	
	__install(self, self.config.out, (cleanup)=>{
		self.config.outCleanup && isFunction(self.config.outCleanup) && self.config.outCleanup(cleanup);
	}, cfg.installationToken);
}


function __getConfig(self, cfg) {
	self.config.out = cfg.out && isFunction(cfg.out) || self.config.out;
	self.config.outCleanup = cfg.outCleanup && isFunction(cfg.outCleanup) || self.config.outCleanup || NOP;

	self.config.install = cfg.install === undefined && self.config.install || cfg.install;
	self.config.stopService = cfg.stopService === undefined && self.config.stopService || cfg.stopService;
	self.config.startService = cfg.startService === undefined && self.config.startService || cfg.startService;
	self.config.wipeData = cfg.wipeData === undefined && self.config.wipeData || cfg.wipeData;
	self.config.checkHealth = cfg.checkHealth === undefined && self.config.checkHealth || cfg.checkHealth;
	self.config.listValidatorKeys = cfg.listValidatorKeys === undefined && self.config.listValidatorKeys || cfg.listValidatorKeys;
	self.config.checkHealthRetryCount = cfg.checkHealthRetryCount === undefined && self.config.checkHealthRetryCount || cfg.checkHealthRetryCount;
	self.config.checkHealthRetryDelay = cfg.checkHealthRetryDelay === undefined && self.config.checkHealthRetryDelay || cfg.checkHealthRetryDelay;
	self.config.checkService = cfg.checkService === undefined && self.config.checkService || cfg.checkService;
	self.config.checkSystem = cfg.checkSystem === undefined && self.config.checkSystem || cfg.checkSystem;
	self.config.ssh = cfg.ssh === undefined && self.config.ssh || cfg.ssh;
	return self;
}

function __install(self, printout, cleanupCallback, installationToken) {

	function parse(prefix, stream, filter) {
		return function(data) {
			data.toString()
			.split(/\r?\n/).forEach(
				function(str){
					printout((prefix || '') + str);
					filter && filter(str, stream.stdin);
				});
		}
	}

	function raw(prefix, stream, filter) {
		return function(data) {
			let str = data.toString();
			printout((prefix || '') + str);
			filter && filter(str, stream.stdin);
		}
	}

	function loginFilter(next) {
		next = next || function(str){
			self.emit(Constants.EventPrefix + 'install.log', str);
		}
		return (str, out) => {
			switch (true) {
				case /^\[sudo\].*\: ?$/.test(str):
				printout('Client :: write-sudo-password');
				out.write(self.config.ssh.password);
				out.write('\n');
				break;;
				default:
				next(str, out);
			}
		}
	}

	function jsonParseFilter(resultAcceptor) {
		return (str) => {
			try {
				resultAcceptor(undefined, JSON.parse(str));
			} catch (err) {
				resultAcceptor(str, undefined);
			}
		}
	}

	function checkDistribution(next) {
		next = isFunction(next) || end;
		return () => {
			self.exec('cat /etc/centos-release',
			{
				pty: false
			},
			function(err, stream) {
				if (err) throw err;

				let result = {
					canInstall: false,
					releaseVersion: undefined
				};

				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					self.emit(Constants.EventPrefix + 'distrib.result', code, code == 0, result);
					if(result.canInstall) {
						next();
					} else {
						end();
					}
				});
				stream.on('data', raw('out: ', stream, (str) => {
					result.releaseVersion = str.trim('\n');
					result.canInstall = /^Cent[Oo][Ss](?:\s+|release|\w+)*(7\.\d+)(\.?\d+)?.*\n?$/.test(str);
				}))
				.stderr.on('data', raw('err: ', stream));
			});
		};
	}
	function installEtherus(next) {
		next = isFunction(next) || end;
		return () => {
			printout('Client :: ready');
			self.exec(
				(self.scriptArgs && self.scriptArgs + '; ')+
				'eval "$(curl -s \'https://raw.githubusercontent.com/etherus-org/etherctl/'+self.branch+'/centos_7_install_bootstrap\')"'+
				(self.privateValidatorKeys && ' -vpk '+self.privateValidatorKeys.join(' ')),
			{
				pty: true
			},
			function(err, stream) {
				if (err) throw err;
				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					self.emit(Constants.EventPrefix + 'install.result', code, code == 0);
					next();
				});
				stream.on('data', parse('out: ', stream, loginFilter()))
				.stderr.on('data', parse('err: ', stream, loginFilter()));
			});
		};
	}
	function checkInstallation(port, name, next) {
		next = isFunction(next) || end;
		return () => {
			self.exec('for i in $(seq 5); do echo "Service try $i" >&2; curl http://localhost:' + port + '/status && exit 0 || sleep 1; done; exit 1',
			{
				pty: false
			},
			function(err, stream) {
				if (err) throw err;

				let error;
				let value;

				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					self.emit(Constants.EventPrefix + 'checkService.result', code, code == 0,
					{
						name: name,
						error: error,
						value: value
					});
					if(value && (code == 0)) {
						next();
					}else{
						end();
					}
				});
				stream.on('data', raw('out: ', stream, jsonParseFilter((e, v) => {
					value = v;
					error = e;
				})))
				.stderr.on('data', raw('err: ', stream));
			});
		};
	}
	function checkHealth(port, name, retry, next, retryBase) {
		next = isFunction(next) || end;
		retryBase = retryBase || retry;
		return () => {
			self.exec('for i in $(seq 5); do echo "Service try $i" >&2; curl http://localhost:' + port + '/dump_consensus_state && exit 0 || sleep 1; done; exit 1',
			{
				pty: false
			},
			function(err, stream) {
				if (err) throw err;

				let buffer='';

				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					let error;
					let progress=[];
					let live = false;
					jsonParseFilter((e, v) => {
						live = checkNodeAlive(v, printout, progress);
						error = e;
					})(buffer);
					printout(name+' live='+live);

					if(code == 0 && !live && retry > 0) {
						printout('Retry '+name+' :: count: ' + retry);
						self.emit(Constants.EventPrefix + 'checkHealth.retry', code, code == 0,
						{
							name: name,
							retry: [ retry, retryBase ],
							progress: progress,
							error: error
						});
						scheduleNext(checkHealth(port, name, retry-1, next, retryBase), self.config.checkHealthRetryDelay);
					} else {
						setLive(name, live);
						self.emit(Constants.EventPrefix + 'checkHealth.result', code, code == 0,
						{
							name: name,
							live: live,
							progress: progress,
							error: error
						});
						if(live && (code == 0)) {
							next();
						}else{
							end();
						}
					}
				});
				stream.on('data', raw('out: ', stream, (str)=>buffer+=str))
				.stderr.on('data', raw('err: ', stream));
			});
		};
	}
	function listValidatorKeys(next) {
		next = isFunction(next) || end;
		return () => {
			printout('Client :: ready');
			self.exec('sh -c \'cat "/opt/etherus/nodes/node_1/data/tenderus/config/"*"_validator.json"\' 2>/dev/null || sudo sh -c \'cat "/opt/etherus/nodes/node_1/data/tenderus/config/"*"_validator.json"\'',
			{
				pty: true
			},
			function(err, stream) {
				if (err) throw err;

				let buffer='';

				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					keysListed=true;
					self.emit(Constants.EventPrefix + 'listValidatorKeys.result', code, code == 0, buffer);
					next();
				});
				stream.on('data', raw('out: ', stream, loginFilter((str)=>buffer+=str)))
				.stderr.on('data', raw('err: ', stream, loginFilter()));
			});
		};
	}
	function stopService(next) {
		next = isFunction(next) || end;
		return () => {
			printout('Client :: ready');
			self.exec('command -v systemctl &>/dev/null || exit 1 && [ "$(id -u)" = "0" ] && systemctl stop etherus.target || command -v sudo &>/dev/null && sudo systemctl stop etherus.target',
			{
				pty: true
			},
			function(err, stream) {
				if (err) throw err;
				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					self.emit(Constants.EventPrefix + 'stopService.result', code, code == 0);
					next();
				});
				stream.on('data', raw('out: ', stream, loginFilter(NOP)))
				.stderr.on('data', raw('err: ', stream, loginFilter()));
			});
		};
	}
	function startService(next) {
		next = isFunction(next) || end;
		return () => {
			printout('Client :: ready');
			self.exec('command -v systemctl &>/dev/null || exit 1 && [ "$(id -u)" = "0" ] && systemctl start etherus.target || command -v sudo &>/dev/null && sudo systemctl start etherus.target',
			{
				pty: true
			},
			function(err, stream) {
				if (err) throw err;
				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					serviceStarted=true;
					self.emit(Constants.EventPrefix + 'startService.result', code, code == 0);
					next();
				});
				stream.on('data', raw('out: ', stream, loginFilter(NOP)))
				.stderr.on('data', raw('err: ', stream, loginFilter()));
			});
		};
	}
	function wipeData(id, name, next) {
		next = isFunction(next) || end;
		id = id || 0;
		name = name || 'node_'+id;
		return () => {
			printout('Client :: ready');
			self.exec('[ -z "$(id -u etherus 2>/dev/null)" ] && exit -1 || [ "$(id -u)" = "$(id -u etherus 2>/dev/null)" ] && { cd /opt/etherus && ./etherctl wipedata_'+id+' || exit 1; } || command -v su &>/dev/null || exit -2 && [ "$(id -u)" = "0" ] && { su etherus -s"/bin/sh" -c"cd /opt/etherus && ./etherctl wipedata_'+id+'" || exit 1; } || command -v sudo &>/dev/null && { sudo su etherus -s"/bin/sh" -c"cd /opt/etherus && ./etherctl wipedata_'+id+'" || exit 1; } || exit -3',
			{
				pty: true
			},
			function(err, stream) {
				if (err) throw err;
				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					dataWiped=true;
					self.emit(Constants.EventPrefix + 'wipeData.result', code, code == 0, name);
					next();
				});
				stream.on('data', raw('out: ', stream, loginFilter(NOP)))
				.stderr.on('data', raw('err: ', stream, loginFilter()));
			});
		};
	}
	let snAlive=false;
	let vnAlive=false;
	let keysListed=false;
	let dataWiped=false;
	let serviceStarted=false;
	function setLive(name, value){
		switch (name) {
			case 'SentryNode': snAlive=value;
			break;
			case 'ValidatorNode': vnAlive=value;
			break;
		}
	}
	function getStatus(){
		let r = true;
		if(self.config.checkHealth) {
			r = r && snAlive;
			r = r && vnAlive;
		}
		if(self.config.listValidatorKeys) {
			r = r && keysListed;
		}
		if(self.config.wipeData) {
			r = r && dataWiped;
		}
		if(self.config.startService) {
			r = r && serviceStarted;
		}
		return r;
	}
	let running=true;
	function scheduleNext(callback, delay) {
		setTimeout(() => {
			if(running) {
				callback();
			}
		}, delay);
	}
	function end() {
		running=false;
		self.end();
	}
	self.on('close', (error) => {
		self.emit(Constants.EventPrefix + 'result', getStatus(), installationToken, error);
		cleanupCallback(snAlive && vnAlive);
	});
	let tail=undefined;
	if(self.config.checkHealth) {
		console.log("CheckHealth: enabled");
		tail=checkHealth(6660, 'ValidatorNode', self.config.checkHealthRetryCount, tail);
		tail=checkHealth(6657, 'SentryNode', self.config.checkHealthRetryCount, tail);
	}
	if(self.config.listValidatorKeys) {
		console.log("ListValidatorKeys: enabled");
		tail=listValidatorKeys(tail);
	}
	if(self.config.checkService) {
		console.log("CheckService: enabled");
		tail=checkInstallation(6660, 'ValidatorNode',tail);
		tail=checkInstallation(6657, 'SentryNode',tail);
	}
	if(self.config.startService) {
		console.log("StartService: enabled");
		tail=startService(tail);
	}
	if(self.config.wipeData) {
		if(self.config.wipeData instanceof Array) {
			console.log("WipeDataArray: enabled");
			for (var i = self.config.wipeData.length - 1; i >= 0; i--) {
				let id = self.config.wipeData[i];
				tail=wipeData(id, 'node_'+id, tail);
			}
		} else {
			console.log("WipeData: enabled");
			tail=wipeData(0, 'SentryNode', tail);
		}
	}
	if(self.config.stopService) {
		console.log("StopService: enabled");
		tail=stopService(tail);
	}
	if(self.config.install) {
		console.log("Install: enabled");
		tail=installEtherus(tail);
	}
	if(self.config.checkSystem) {
		console.log("CheckSystem: enabled");
		tail=checkDistribution(tail);
	}
	self.on('ready', tail).connect(self.config.ssh);
};

EtherusSSHInstaller.EtherusSSHInstaller = EtherusSSHInstaller;
EtherusSSHInstaller.Constants = Constants;

module.exports = EtherusSSHInstaller;
