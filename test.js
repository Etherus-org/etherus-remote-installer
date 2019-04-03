const EtherusSSHInstaller = require('./index').EtherusSSHInstaller;
const ep = EtherusSSHInstaller.Constants.EventPrefix;

let installer = new EtherusSSHInstaller();

Object.prototype.getPath = function(...path){
	let self = this;
	return path.reduce((xs, x) => (xs && xs[x]) ? xs[x] : undefined, self);
}

Object.prototype.then = function(callback){
	let self = this;
	return self && callback(self);
}

console.log("Installation...");

installer.install({
	ssh:{
		host: 'localhost',
		port: 22,
		//username: 'user',
		//password: 'password'
	}
});

installer.on(ep + 'install.log', function(str){
	str && console.log(str);
});

installer.on(ep + 'distrib.result', function(code, success, result) {
	console.log("Result: " + JSON.stringify(result, null, 2));
});

installer.on(ep + 'install.result', function(code, success){
	console.log("Installation success: " + success);
});

installer.on(ep + 'checkService.result', function(code, success, service){
	let info = {
		network: service.getPath('value', 'result', 'node_info', 'network'),
		version: service.getPath('value', 'result', 'node_info', 'version')
	}
	switch(service.name) {
		case "ValidatorNode":
		info.validator = (key=>key && '0x'+key.toLowerCase())(service.getPath('value', 'result', 'validator_info', 'pub_key_hex'));
		break;
		case "SentryNode":
		info.node_id= service.getPath('value', 'result', 'node_info', 'id');
		break;
	}
	console.log("Service " + service.name + ": " + JSON.stringify(info, null, 2));
});

installer.on(ep + 'checkHealth.result', function(code, success, service){
	let info = {
		name: service.name,
		live: service.getPath('value', 'live')
	}
	console.log('Service '+service.name+(service.value && ' is ready' || ' is broken'), info);
});

installer.on(ep + 'result', function(success, logFilePath) {
	console.log("Result: " + ((success && 'success') || 'failure\nLogFile: '+logFilePath));
});
