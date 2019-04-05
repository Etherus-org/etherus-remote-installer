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
}
inherits(EtherusSSHInstaller, Client);

function isFunction(arg) {
	return arg instanceof Function && arg;
}

function NOP(){}

Client.prototype.install = function(cfg) {
	let self = this;

	self.config.out = cfg.out && isFunction(cfg.out) || self.config.out;
	self.config.outCleanup = cfg.outCleanup && isFunction(cfg.outCleanup) || self.config.outCleanup || NOP;
	self.config.install = cfg.install || self.config.install;
	self.config.checkHealth = cfg.checkHealth || self.config.checkHealth;
	self.config.listValidatorKeys = cfg.listValidatorKeys || self.config.listValidatorKeys;
	self.config.checkHealthRetryCount = cfg.checkHealthRetryCount || self.config.checkHealthRetryCount;
	self.config.checkHealthRetryDelay = cfg.checkHealthRetryDelay || self.config.checkHealthRetryDelay;
	self.config.checkService = cfg.checkService || self.config.checkService;
	self.config.checkSystem = cfg.checkSystem || self.config.checkSystem;
	self.config.ssh = cfg.ssh || self.config.ssh;

	__install(self, self.config.out, (cleanup)=>{
		self.config.outCleanup && isFunction(self.config.outCleanup) && self.config.outCleanup(cleanup);
	}, cfg.installationToken);
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
			self.exec((self.scriptArgs && self.scriptArgs + '; ')+'eval "$(curl -s \'https://raw.githubusercontent.com/etherus-org/etherctl/'+self.branch+'/centos_7_install_bootstrap\')"',
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
					self.emit(Constants.EventPrefix + 'listValidatorKeys.result', code, code == 0, buffer);
					next();
				});
				stream.on('data', raw('out: ', stream, loginFilter((str)=>buffer+=str)))
				.stderr.on('data', raw('err: ', stream, loginFilter()));
			});
		};
	}
	let snAlive=false;
	let vnAlive=false;
	function setLive(name, value){
		switch (name) {
			case 'SentryNode': snAlive=value;
			break;
			case 'ValidatorNode': vnAlive=value;
			break;
		}
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
		self.emit(Constants.EventPrefix + 'result', snAlive && vnAlive, installationToken, error);
		cleanupCallback(snAlive && vnAlive);
	});
	let tail=undefined;
	if(self.config.checkHealth) {
		tail=checkHealth(6660, 'ValidatorNode', self.config.checkHealthRetryCount, tail);
		tail=checkHealth(6657, 'SentryNode', self.config.checkHealthRetryCount, tail);
	}
	if(self.config.listValidatorKeys) {
		tail=listValidatorKeys(tail);
	}
	if(self.config.checkService) {
		tail=checkInstallation(6660, 'ValidatorNode',tail);
		tail=checkInstallation(6657, 'SentryNode',tail);
	}
	if(self.config.install) {
		tail=installEtherus(tail);
	}
	if(self.config.checkSystem) {
		tail=checkDistribution(tail);
	}
	self.on('ready', tail).connect(self.config.ssh);
};

EtherusSSHInstaller.EtherusSSHInstaller = EtherusSSHInstaller;
EtherusSSHInstaller.Constants = Constants;

module.exports = EtherusSSHInstaller;
