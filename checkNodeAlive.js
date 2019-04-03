

Object.prototype.safePath = function(name) {
	let self = this;
	return (...path)=>new SafePath(name, path.reduce((xs, x) => (xs && xs[x]) ? xs[x] : undefined, self));
}

function checkNodeAlive(data, log, progress) {
	data=data && data.result
	if(!data) {
		return false;
	}
	let height = Number(data.safePath('height')('round_state','height').notEmpty().notNegative().get());
	let peers = data.safePath('peers')('peers').notEmptyArray().get();
	let heights = peers.map((peer, i) => peer.safePath('peer['+i+'].height')('peer_state','round_state','height').supress(true).notEmpty().notNegative().get(0));
	log(JSON.stringify(heights, null, 2));
	let maxHeight = Math.max(height, ...heights);
	log('Node height: '+height+' of '+maxHeight);
	log('Node isLive: '+(height == maxHeight && height > 1));
	if(progress) {
		progress[0] = height;
		progress[1] = maxHeight;
	}
	return (height == maxHeight && height > 1);
}

function SafePath(name, obj) {
	function fireThrow(err) {
		throw err;
	}
	function fireDrop(err) {
	}
	this.fire = fireThrow;
	this.supress = function(supress) {
		this.fire = supress ? fireDrop : fireThrow;
		return this;
	}
	this.isDefined = function(){
		if(obj === undefined) {
			this.fire(new Error(name+' undefined'));
		}
		return this;
	}
	this.notEmpty = function(){
		this.isDefined();
		if(obj == '') {
			this.fire(new Error(name+' is empty'));
		}
		return this;
	}
	this.isArray = function(){
		if(!Array.isArray(obj)) {
			this.fire(new Error(name+' is not an array'));
		}
		return this;
	}
	this.notEmptyArray = function(){
		this.isArray();
		if(obj.length<=0) {
			this.fire(new Error(name+' is empty array'));
		}
		return this;
	}
	this.isNumber = function(){
		if(isNaN(obj)) {
			this.fire(new Error(name+' is not a number'));
		}
		return this;
	}
	this.notNegative = function(){
		this.isNumber();
		if(obj<0) {
			this.fire(new Error(name+' is negative'));
		}
		return this;
	}
	this.isPositive = function(){
		this.isNumber();
		if(obj<=0) {
			this.fire(new Error(name+' is not positive'));
		}
		return this;
	}
	this.get = function(value){
		return obj || value;
	};
}

module.exports=checkNodeAlive;
