const EtherusSSHInstaller = require('./EtherusSSHInstaller').EtherusSSHInstaller;
const ep = EtherusSSHInstaller.Constants.EventPrefix;

function handleCommand(stdout, stderr, command, params, config) {
	try{
		switch (command) {
			case 'install':
			return runInstallation(stdout, stderr, params, config);
			case 'backup':
			return runBackup(stdout, stderr, params, config);
			case 'reset':
			return runReset(stdout, stderr, params, config);
			default:
			return Promise.reject('Unknown command: '+command);
		}
	} catch(err) {
		console.log(err);
		if(err instanceof InstallerServiceError) {
			return Promise.reject(err.message);
		} else {
			return Promise.reject('Internal Service Error');
		}
	}
}

function InstallerServiceError(message) {
	if (!(this instanceof InstallerServiceError))
		return new InstallerServiceError(message);
	this.name = this.constructor.name;
	this.message = message;
	if (Error.captureStackTrace) {
		Error.captureStackTrace(this, this.constructor);
	} else {
		this.stack = (new Error()).stack;
	}
}
InstallerServiceError.prototype = Object.create(Error.prototype);
InstallerServiceError.prototype.constructor = InstallerServiceError;

function PropertyRequiredError(property) {
	InstallerServiceError.call(this, 'No ' + property + ' specified');
}
PropertyRequiredError.prototype = Object.create(InstallerServiceError.prototype);
PropertyRequiredError.prototype.constructor = PropertyRequiredError;


function _injectGetPath(obj) {
	if(obj !== undefined){
		obj.getPath = function(...path){
			let self = this;
			return path.reduce((xs, x) => (xs && xs[x]) ? xs[x] : undefined, self);
		}
	}
	return obj;
}

function runExecution(stdout, stderr, cfg, options) {
	if(!cfg.ssh) throw new PropertyRequiredError('ssh');
	if(!cfg.ssh.username) throw new PropertyRequiredError('ssh.username');
	if(!cfg.ssh.password) throw new PropertyRequiredError('ssh.password');
	if(!cfg.ssh.host) throw new PropertyRequiredError('ssh.host');
	cfg.ssh.port = cfg.ssh.port || 22;

	cfg.checkHealthRetryCount = cfg.checkHealthRetryCount || 1000;
	cfg.checkHealthRetryDelay = cfg.checkHealthRetryDelay || 5000;

	try {
		return new Promise((accept, reject) => {
			let installer = new EtherusSSHInstaller(options);
			installer.on('error', function(err){
				console.error(err);
				let error = err.message;
				if(!error){
					error+= err.level?err.level + ': ':'';
					error+= err.syscall?err.syscall:'';
					error+= err.code?'.' + err.code+' ':' ';
					error+= (err.hostname || err.address)?(err.hostname || err.address):'';
					error+= err.port?':' + err.port:'';
				}
				reject(error);
				installer.end();
			});
			installer.on(ep + 'install.log', function(str){
				str && stdout(str);
			});
			installer.on(ep + 'stopService.result', function(code, success){
				if(success) {
					stdout('Etherus stopped succesfully');
				} else {
					stderr('Could not stop Etherus');
				}
			});
			installer.on(ep + 'startService.result', function(code, success){
				if(success) {
					stdout('Etherus started succesfully');
				} else {
					stderr('Could not start Etherus');
				}
			});
			installer.on(ep + 'wipeData.result', function(code, success, name){
				if(success) {
					stdout('Etherus '+name+' reset succesfully');
				} else {
					stderr('Could not wipe Etherus '+name+' data');
				}
			});
			installer.on(ep + 'distrib.result', function(code, success, result) {
				if(success){
					if(result.canInstall) {
						stdout('Detected CentOS version '+result.releaseVersion);
					} else {
						stderr('Could not detect CentOS version', result.releaseVersion);
					}
				} else {
					stderr('Could not detect CentOS version')
				}
			});
			installer.on(ep + 'install.result', function(code, success){
				stdout('Installation '+(success && ' successful' || ' failed'), {installation:{success:success}});
			});
			installer.on(ep + 'checkService.result', function(code, success, service){
				_injectGetPath(service);
				let info = {
					name: service.name,
					network: service.getPath('value', 'result', 'node_info', 'network'),
					version: service.getPath('value', 'result', 'node_info', 'version'),
					err: service.getPath('error')
				}
				switch(service.name) {
					case "ValidatorNode":
					let vPub = (key=>key && '0x'+key.toLowerCase())(service.getPath('value', 'result', 'validator_info', 'pub_key_hex'));
					info.validator = vPub;
					cfg.vPubCallback && cfg.vPubCallback instanceof Function && cfg.vPubCallback(vPub);
					break;
					case "SentryNode":
					info.node_id= service.getPath('value', 'result', 'node_info', 'id');
					break;
				}
				stdout('Service '+service.name+(service.value && ' is running' || ' is missing'), info);
			});
			installer.on(ep + 'precheckService.result', function(code, success, service){
				stdout('Service '+service.name+(success && ' is synchronizing' || ' is steady'), {
					name: service.name,
					block: service.block,
					speed: service.speed
				});
			});
			installer.on(ep + 'listValidatorKeys.result', function(code, success, validatorKey){
				try {
					cfg.vPrivCallback && cfg.vPrivCallback instanceof Function && cfg.vPrivCallback(validatorKey);
				}catch(error){
					reject(error);
					installer.end();
				}
			});
			installer.on(ep + 'checkHealth.result', function(code, success, service){
				let info = {
					name: service.name,
					live: service.live,
					progress: service.progress
				}
				stdout('Service '+service.name+(service.live && ' is ready' || ' is broken'), info);
			});
			installer.on(ep + 'checkHealth.retry', function(code, success, service){
				let info = {
					name: service.name,
					retry: service.retry,
					progress: service.progress
				}
				stdout('Retry '+service.name+' check', info);
			});
			let timeout = setTimeout(()=>{reject('Result timed out')}, (10*60*1000)+(cfg.checkHealthRetryDelay*cfg.checkHealthRetryCount));
			installer.on(ep + 'result', function(success, token) {
				clearTimeout(timeout);
				console.log('Finished ' + token + ': ' + (success?'success':'failure'));
				stdout('Execution finished', {execution:{success:success, token:token}});
				accept(success);
			});
			installer.install(cfg);
		});
	} catch (err) {
		return Promise.reject(err);
	}
}

function runInstallation(stdout, stderr, cfg, options) {
	cfg.stopService = false;
	cfg.wipeData = false;

	cfg.install = true;
	options = options || {};
	options.scriptArgs = options.scriptArgs || [];
	options.scriptArgs.push('MODE=remote');

	cfg.checkSystem = true;
	cfg.startService = true;
	cfg.checkHealth = true;

	if(cfg.vPubCallback) {
		cfg.checkService = true;
	} else {
		cfg.checkService = false;
	}
	if(cfg.vPrivCallback) {
		cfg.listValidatorKeys = true;
	} else {
		cfg.listValidatorKeys = false;
	}

	return runExecution(stdout, stderr, cfg, options)
}

function runBackup(stdout, stderr, cfg, options) {
	cfg.checkSystem = false;
	cfg.install = false;
	cfg.wipeData = false;
	cfg.startService = false;
	cfg.checkService = false;
	cfg.checkHealth = false;
	cfg.precheckService = false;

	cfg.stopService = true;

	if(cfg.vPubCallback) {
		cfg.checkService = true;
	} else {
		cfg.checkService = false;
	}
	if(cfg.vPrivCallback) {
		cfg.listValidatorKeys = true;
	} else {
		throw new InstallerServiceError('Not configured vPrivCallback');
	}

	return runExecution(stdout, stderr, cfg, options)
}

function runReset(stdout, stderr, cfg, options) {
	cfg.checkHealth = cfg.checkHealth && true || false;

	cfg.checkSystem = false;
	cfg.listValidatorKeys = false;

	cfg.install = true;
	options = options || {};
	options.scriptArgs = options.scriptArgs || [];
	options.scriptArgs.push('MODE=remote');
	options.scriptArgs.push('COMMAND=init');

	cfg.stopService = true;
	cfg.wipeData = [0, 1];
	cfg.startService = true;

	if(cfg.vPubCallback) {
		cfg.checkService = true;
	} else {
		cfg.checkService = false;
	}
	if(cfg.vPrivCallback) {
		cfg.listValidatorKeys = true;
	} else {
		cfg.listValidatorKeys = false;
	}

	return runExecution(stdout, stderr, cfg, options)
}

module.exports.InstallerWS=module.exports;
module.exports={
	handleCommand: handleCommand
};