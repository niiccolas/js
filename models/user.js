var User	=	Protected.extend({
	base_url: '/users',
	local_table: 'user',

	relations: {
		personas: {
			type: Composer.HasMany,
			filter_collection: 'PersonasFilter',
			master: function() { return turtl.profile.get('personas'); },
			options: {
				filter: function(p) {
					return p.get('user_id') == turtl.user.id();
				}
			},
			forward_events: true,
			delayed_init: true
		},

		settings: {
			type: Composer.HasMany,
			collection: 'Settings',
			forward_events: true
		}
	},

	public_fields: [
		'id'
	],

	private_fields: [
		'settings'
	],

	logged_in: false,

	key: null,
	auth: null,

	init: function()
	{
		this.logged_in		=	false;

		// whenever the user settings change, automatically save them (encrypted).
		this.bind_relational('settings', ['change'], this.save_settings.bind(this), 'user:save_settings');
	},

	login: function(data, remember, silent)
	{
		(remember === true) || (remember = false);
		(silent === true) || (silent = false);
		this.set(data);
		this.get_auth();
		this.unset('username');
		this.unset('password');
		this.logged_in	=	true;
		var duration	=	1;
		if(remember)
		{
			duration	=	30;
		}

		this.write_cookie({duration: duration});
		if (!silent) this.trigger('login', this);
	},

	login_from_auth: function(auth)
	{
		if(!auth) return false;
		this.set({id: auth.uid});
		this.auth		=	auth.auth;
		this.key		=	tcrypt.key_to_bin(auth.key);
		this.logged_in	=	true;
		this.trigger('login', this);
	},

	login_from_cookie: function()
	{
		var cookie	=	Cookie.read(config.user_cookie);
		if(cookie == null)
		{
			return false;
		}
		var userdata	=	JSON.decode(cookie);
		var key			=	tcrypt.key_to_bin(userdata.k);
		var auth		=	userdata.a;
		delete userdata.k;
		delete userdata.a;
		this.key	=	key;
		this.auth	=	auth;
		this.set(userdata);
		this.logged_in	=	true;
		this.trigger('login', this);
	},

	/**
	 * add a new user.
	 *
	 * note that we don't do the usual model -> local db -> API pattern here
	 * because the local db relies on the user id (which is generated by the
	 * API) and because in the off-chance that there's a failure syncing the
	 * user record after the fact, it could serverely screw some things up in
	 * the client.
	 *
	 * instead, we post to the API, then once we have a full user record that we
	 * know is in the API, we wait for the local DB to init (poll it) and then
	 * add our shiny new user record to it.
	 */
	join: function(options)
	{
		options || (options = {});
		turtl.api.post('/users', {data: {a: this.get_auth()}}, {
			success: function() {
				// once we have the user record, wait until the user is logged
				// in. then we poll turtl.db until our local db object exists.
				// once we're sure we have it, we save the new user record to
				// the local db.
				this.bind('login', function() {
					this.unbind('login', 'user:join:add_local_record');
					var check_db	=	function()
					{
						if(!turtl.db)
						{
							check_db.delay(10, this);
							return false;
						}
						this.save();
					}.bind(this);
					check_db.delay(1, this);
				}.bind(this), 'user:join:add_local_record');
				if(options.success) options.success.apply(this, arguments);
			}.bind(this),
			error: function(e) {
				barfr.barf('Error adding user: '+ e);
				if(options.error) options.error(e);
			}.bind(this)
		});
	},

	write_cookie: function(options)
	{
		options || (options = {});
		var duration	=	options.duration ? options.duration : 30;
		var key			=	this.get_key();
		var auth		=	this.get_auth();
		if(!key || !auth) return false;

		var save		=	{
			id: this.id(),
			k: tcrypt.key_to_string(key),
			a: auth,
			last_board: this.get('last_board')
		};
		Cookie.write(config.user_cookie, JSON.encode(save), { duration: duration });
	},

	logout: function()
	{
		this.auth = null;
		this.key = null;
		this.logged_in	=	false;
		this.clear();
		Cookie.dispose(config.user_cookie);
		this.unbind_relational('personas', ['saved'], 'user:track_personas');
		this.unbind_relational('personas', ['destroy'], 'user:track_personas:destroy');
		this.unbind_relational('settings', ['change'], 'user:save_settings');

		// clear user data
		this.get('personas').each(function(p) {
			p.unbind();
			p.destroy({silent: true, skip_remote_sync: true});
		});
		this.get('personas').unbind().clear();
		this.get('settings').unbind().clear();
		this.trigger('logout', this);
	},

	save_settings: function()
	{
		console.log('save: user:  mem -> db', Object.getLength(turtl.user.get('settings').get_by_key('keys').value()));
		this.save({
			success: function(res) {
				this.trigger('saved', res);
			}.bind(this),
			error: function(model, err) {
				barfr.barf('There was an error saving your user settings: '+ err);
			}.bind(this)
		});
	},

	get_key: function()
	{
		var key = this.key;
		if(key) return key;

		var username = this.get('username');
		var password = this.get('password');

		if(!username || !password) return false;

		// TODO: abstract key generation a bit better (iterations/keysize mainly)
		var key = tcrypt.key(password, username + ':a_pinch_of_salt', {key_size: 32, iterations: 400});

		// cache it
		this.key = key;

		return key;
	},

	get_auth: function()
	{
		if(this.auth) return this.auth;

		var username = this.get('username');
		var password = this.get('password');

		if(!username || !password) return false;

		var user_record = tcrypt.hash(password) +':'+ username;
		// use username as salt/initial vector
		var key	=	this.get_key();
		var iv	=	tcrypt.iv(username+'4c281987249be78a');	// make sure IV always has 16 bytes

		// note we serialize with version 0 (the original Turtl serialization
		// format) for backwards compat
		var auth	=	tcrypt.encrypt(key, user_record, {iv: iv, version: 0}).toString();

		// save auth
		this.auth	=	auth;

		return auth;
	},

	test_auth: function(options)
	{
		options || (options = {});
		turtl.api.set_auth(this.get_auth());
		turtl.api.post('/auth', {}, {
			success: options.success,
			error: options.error
		});
		turtl.api.clear_auth();
	},

	add_user_key: function(item_id, key)
	{
		if(!item_id || !key) return false;
		var user_keys		=	Object.clone(this.get('settings').get_by_key('keys').value()) || {};
		user_keys[item_id]	=	tcrypt.key_to_string(key);
		this.get('settings').get_by_key('keys').value(user_keys);
	},

	remove_user_key: function(item_id)
	{
		if(!item_id) return false;
		var user_keys	=	Object.clone(this.get('settings').get_by_key('keys').value()) || {};
		delete user_keys[item_id];
		this.get('settings').get_by_key('keys').value(user_keys);
	},

	find_user_key: function(item_id)
	{
		if(!item_id) return false;
		var user_keys	=	Object.clone(this.get('settings').get_by_key('keys').value()) || {};
		var key			=	user_keys[item_id];
		if(!key) return false;
		return tcrypt.key_to_bin(key);
	},

	// -------------------------------------------------------------------------
	// Sync section
	// -------------------------------------------------------------------------
	sync_from_db: function(last_local_sync, options)
	{
		turtl.db.user.query('last_mod')
			.lowerBound(last_local_sync)
			.execute()
			.done(function(userdata) {
				var continuefn	=	function()
				{
					if(options.success) options.success();
					return false;
				};

				if(userdata.length == 0) return continuefn();
				var userdata	=	userdata[0];

				if(turtl.sync.should_ignore([userdata.id])) return continuefn();

				if(userdata.last_mod < last_local_sync) return continuefn();
				this.set(userdata);
				console.log('sync: user:  db -> mem', Object.getLength(turtl.user.get('settings').get_by_key('keys').value()));

				continuefn();
			}.bind(this))
			.fail(function(e) {
				barfr.barf('Problem syncing user record locally: '+ e);
				console.log('user.sync_from_db: error: ', e);
				if(options.error) options.error();
			});
	},

	sync_to_api: function()
	{
		turtl.db.user.query('local_change')
			.only(1)
			.modify({local_change: 0})
			.execute()
			.done(function(userdata) {
				if(userdata.length == 0) return false;
				userdata	=	userdata[0];

				// "borrow" some code from the SyncCollection
				var collection	=	new SyncCollection([], {
					model: User,
					local_table: 'user'
				});
				console.log('sync: user:  db -> api');
				collection.sync_record_to_api(userdata);
			}.bind(this))
			.fail(function(e) {
				barfr.barf('Problem syncing user record remotely: '+ e);
				console.log('user.sync_to_api: error: ', e);
			});
	},

	sync_from_api: function(table, syncdata)
	{
		// check that we aren't ignoring user on remote sync
		if(turtl.sync.should_ignore([syncdata.id, syncdata.cid], {type: 'remote'})) return false;
		syncdata.key		=	'user';
		syncdata.last_mod	=	new Date().getTime();
		console.log('sync: user:  api -> db');
		table.update(syncdata);
	}
});

