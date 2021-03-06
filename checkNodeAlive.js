

Object.prototype.safePath = function(name) {
	let self = this;
	return (...path)=>new SafePath(name, path.reduce((xs, x) => (xs && xs[x]) ? xs[x] : undefined, self));
}

function checkNodeAlive(data, log, progress, altData) {
	try {
		data=data && data.result;
		altData=altData && altData.result;
		if(!data) {
			return false;
		}
		let height = Number(data.safePath('height')('round_state','height').notEmpty().notNegative().get());
		if(altData) {
			height = Math.max(height, Number(altData.safePath('alt_height')('sync_info','latest_block_height').notEmpty().notNegative().get()));
		}
		height = height || height !== 0 && -1 || 0;
		let peers = data.safePath('peers')('peers').isArray().get();
		if(peers.length == 0) {

		}
		let heights = peers.map((peer, i) => peer.safePath('peer['+i+'].height')('peer_state','round_state','height').supress(true).notEmpty().notNegative().get(0));
		log(JSON.stringify(heights, null, 2));
		let maxHeight = progress && (progress[1] || progress[1] !== 0 && -1 || 0) || -1;
		maxHeight = Math.max(maxHeight, ...heights);
		log('Node height: '+height+' of '+maxHeight);
		log('Node isLive: '+(height == maxHeight && height > 1));
		if(progress) {
			progress[0] = height;
			progress[1] = maxHeight;
		}
		return (height == maxHeight && height > 1);
	} catch (err) {
		log(err);
		progress[0] = progress[0] || -1;
		progress[1] = progress[1] || -1;
		return false;
	}
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
