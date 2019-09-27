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
		precheckService: true,
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
	self.config.precheckService = cfg.precheckService === undefined && self.config.precheckService || cfg.precheckService;
	self.config.ssh = cfg.ssh === undefined && self.config.ssh || cfg.ssh;
	return self;
}

function __install(self, printout, cleanupCallback, installationToken) {

	function parse(prefix, stream, filter) {
		let tail = '';
		let put = function(str){
			printout((prefix || '') + str);
			filter && filter(str, stream.stdin);
		};
		return function(data) {
			let str = data.toString();
			let last = Math.max(str.lastIndexOf('\n'), str.lastIndexOf('\r'));
			if(last == -1) {
				tail += str;
			} else {
				str = tail + str;
				last += tail.length;
				tail = str.slice(last + 1);
				str.slice(0, last).split(/[\r\n]+/).forEach(put);
			}
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
				resultAcceptor(err, str);
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
				(self.scriptArgs && self.scriptArgs.join('\n') + '\n')+
				'eval "$(curl -fs \'https://raw.githubusercontent.com/etherus-org/etherctl/'+self.branch+'/centos_7_install_bootstrap\')"'+
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
			self.exec('for i in $(seq 30); do echo "Service try $i" >&2; curl -fs http://localhost:' + port + '/status && exit 0 || sleep 1; done; exit 1',
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
	function precheckInstallation(port, name, next, shortcut, config) {
		next = isFunction(next) || end;
		shortcut =  isFunction(shortcut) || next;
		config = config || {};
		config.retry = config.retry || 6;
		config.retryDelay = config.retryDelay || 5000;
		config.speedThreshold = config.speedThreshold || 3000;
		let retryCount = 0;
		let firstBlock;
		let latestBlock;
		let speed;
		let process = () => {
			self.exec('for i in $(seq 5); do echo "Service try $i" >&2; curl -fs http://localhost:' + port + '/status && exit 0 || sleep 1; done; exit 1',
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
					printout('Precheck: '+JSON.stringify({
						retryCount: retryCount,
						firstBlock: firstBlock,
						latestBlock: latestBlock,
						speed: speed,
					}));
					if(code !== 0) {
						self.emit(Constants.EventPrefix + 'precheckService.result', -1, false,
						{
							name: name,
							block: 0,
							speed: 0,
						});
						next();
						return;
					}
					if(value) {
						value = _injectGetPath(value);
						let currentBlock = value.getPath('result', 'sync_info', 'latest_block_height');
						if(currentBlock) {
							latestBlock = currentBlock;
							if(firstBlock) {
								let deltaBlock = currentBlock - firstBlock;
								let deltaTime = retryCount * config.retryDelay;
								speed = deltaTime / deltaBlock;
								if(config.speedThreshold > speed) {
									self.emit(Constants.EventPrefix + 'precheckService.result', 0, true,
									{
										name: name,
										block: latestBlock,
										speed: speed,
									});
									shortcut();
									return;
								}
							} else {
								firstBlock = currentBlock;
								retryCount = 0;
							}
						}
					}
					if(error) {
						printout('ParseError: ' + error);
					}
					if(retryCount++ < config.retry) {
						scheduleNext(process, config.retryDelay);
					} else {
						self.emit(Constants.EventPrefix + 'precheckService.result', -1, false,
						{
							name: name,
							block: latestBlock,
							speed: speed,
						});
						next();
					}
				});
				stream.on('data', raw('out: ', stream, jsonParseFilter((e, v) => {
					value = v;
					error = e;
				})))
				.stderr.on('data', raw('err: ', stream));
			});
		};
		return process;
	}
	function checkHealth(port, name, retry, next, retryBase, maxBlock) {
		next = isFunction(next) || end;
		retryBase = retryBase || retry;
		maxBlock = maxBlock || -1;
		return () => {
			self.exec('for i in $(seq 30); do echo "dump_consensus_state try $i" >&2; curl -fs http://localhost:' + port + '/dump_consensus_state && printf \'"""""""\' && '+
				'for j in $(seq 30); do echo "status try $j" >&2; curl -fs http://localhost:' + port + '/status && exit 0 || sleep 1; done '+
				' || sleep 1; done; exit 1',
			{
				pty: false
			},
			function(err, stream) {
				if (err) throw err;

				let buffer='';

				stream
				.on('close', function(code, signal) {
					printout('Stream :: close :: code: ' + code + ', signal: ' + signal);
					let error=[];
					let progress=[-1, maxBlock];
					let live = false;
					let data;
					let altData;
					buffer = buffer.split('"""""""');
					if(buffer[0]) {
						jsonParseFilter((e, v) => {
							if(e) {
								error.push(e.message);
								printout(e + ' at ' + v);
							} else {
								data = v;
							}
						})(buffer[0]);
					}
					if(buffer[1]) {
						jsonParseFilter((e, v) => {
							if(e) {
								error.push(e.message);
								printout(e + ' at ' + v);
							} else {
								altData = v;
							}
						})(buffer[1]);
					}
					live = checkNodeAlive(data, printout, progress, altData);
					printout(name+' live='+live);
					printout(name+' progress='+JSON.stringify(progress));
					maxBlock = Math.max(maxBlock, progress[1] || progress[1] !== 0 && -1 || 0);
					if(code == 0 && !live && retry > 0) {
						printout('Retry '+name+' :: count: ' + retry);
						self.emit(Constants.EventPrefix + 'checkHealth.retry', code, code == 0,
						{
							name: name,
							retry: [ retry, retryBase ],
							progress: progress,
							error: error
						});
						scheduleNext(checkHealth(port, name, retry-1, next, retryBase, maxBlock), self.config.checkHealthRetryDelay);
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
	function doShortcut(next) {
		next = isFunction(next) || end;
		return () => {
			shortCut=true;
			next();
		};
	}
	let snAlive=false;
	let vnAlive=false;
	let keysListed=false;
	let dataWiped=false;
	let serviceStarted=false;
	let shortCut=false;
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
		if(shortCut) {
			return r;
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
	let tail;
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
	let shortcut = doShortcut(tail);
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
	if(self.config.precheckService) {
		console.log("PrecheckService: enabled");
		tail=precheckInstallation(6660, 'ValidatorNode',tail, shortcut);
		tail=precheckInstallation(6657, 'SentryNode',tail, shortcut);
	}
	if(self.config.checkSystem) {
		console.log("CheckSystem: enabled");
		tail=checkDistribution(tail);
	}
	self.on('ready', tail)
	self.on('keyboard-interactive', function(name, instructions, instructionsLang, prompts, finish) {
		console.log('Connection :: keyboard-interactive');
		if(self.config.ssh && self.config.ssh.password) {
			finish([self.config.ssh.password]);
		} else {
			console.log('Connection :: keyboard-interactive :: no password was specified for connection');
		}
	});
	self.connect(self.config.ssh);
};

function _injectGetPath(obj) {
	if(obj !== undefined){
		obj.getPath = function(...path){
			let self = this;
			return path.reduce((xs, x) => (xs && xs[x]) ? xs[x] : undefined, self);
		}
	}
	return obj;
}

EtherusSSHInstaller.EtherusSSHInstaller = EtherusSSHInstaller;
EtherusSSHInstaller.Constants = Constants;

module.exports = EtherusSSHInstaller;
