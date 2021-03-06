var net = require('net'),
    util = require('util'),
    xtend = require('xtend'),

    backends = require('./backends'),

    messages = require('./core/messages'),
    commands = require('./core/commands');


function FTPServer(opts) {
    if (!(this instanceof FTPServer)) return new FTPServer(opts);
    opts = opts || {};

    net.Server.call(this, this.ftp_listener);

    /**
     * Patch server.close: server.closing is checked in the 'data' listener
     * to disallow any more commands while closing.
     */
    this.closing = false;
    var close = this.close;

    this.close = function () {
        this.closing = true;
        close.apply(this);
    };

    // commands can be overridden by modifying exports.commands or passed in to this constructor
    this.commands = xtend({}, commands, opts.commands);

    this.backend_opts = opts.backend || {};

    this.backend = backends[opts.backend] || backends.Filesystem;
}

util.inherits(FTPServer, net.Server);


/**
 * Listener on the server receives a new client socket
 */
FTPServer.prototype.ftp_listener = function listener(socket) {
    /**
     * Configure client connection info
     */
    socket.setTimeout(0);
    socket.setNoDelay();
    socket.dataEncoding = "binary";
    socket.asciiEncoding = "utf8";
    socket.user = {
        authorized: false,
        username: null,
        home: this.backend_opts.root
    };
    socket.passive = {
        // this address is set with PORT and PASV command sequence.
        enabled: false,
        host: socket.localAddress,
        min_port: null, // defaults are the IANA registered ephemeral port range (49152 - 65534).
        max_port: null
    };
    socket.active = {
        host: socket.localAddress,
        port: socket.localPort - 1 // L-1: if control port is default 21, then active data port will be 20
    };

    /**
     * Initialize filesystem
     */
    socket.fs = new this.backend(this.backend_opts);
    // Catch-all
    socket.fs.onError = function (err) {
        if (!err.code) err.code = 550;
        socket.reply(err.code, err.message)
    };

    /**
     * Method for creating a server for passive ftp data transport.
     *
     * It will select a random port within a specified min-max range of ports.
     * Typically this will be invoked by the PASV command implementation.
     */
    socket.createPassiveServer = function (cb) {
        /*
         * Returns a random integer between min and max
         * Using Math.round() will give you a non-uniform distribution!
         */
        var min = socket.passive.min_port || 49152; // defaults are the IANA registered ephemeral port range.
        var max = socket.passive.max_port || 65534;
        var port = Math.floor(Math.random() * (max - min + 1)) + min;
        var server = net.createServer();
        server.listen(port, function () {
            cb(this)
        });

        // We can't bind to this port, so we will keep trying until we get a live one!
        server.on('error', function (err) {
            socket.createPassiveServer(cb)
        });
    };

    /**
     * Socket response shortcut
     */
    socket.server = this;
    socket.reply = function (status, message, callback) {
        if (!message) message = messages[status.toString()] || 'No information';
        if (this.writable) {
            this.write(status.toString() + ' ' + message.toString() + '\r\n', callback)
        }
    };

    /**
     * Data transfer
     */
    socket.dataTransfer = function (handle) {
        function finish(dataSocket) {
            return function (err) {
                if (err) {
                    dataSocket.emit('error', err);
                } else {
                    dataSocket.end();
                }
            }
        }

        function execute() {
            socket.reply(150);
            handle.call(socket, this, finish(this))
        }

        // Will be unqueued in PASV command
        if (socket.passive.enabled) {
            socket.dataTransfer.queue.push(execute)
        }
        // Or we initialize directly the connection to the client
        else {
            net.createConnection(socket.active.port, socket.active.host).on('connect', execute)
        }
    };
    socket.dataTransfer.queue = [];

    /**
     * Received a command from socket
     */
    socket.on('data', function (chunk) {

        // If server is closing, refuse all commands
        if (socket.server.closing) {
            socket.reply(421)
        }

        // Parse received command and reply accordingly
        var parts = chunk.toString().trim().split(" "),
            command = parts[0].trim().toUpperCase(),
            args = parts.slice(1, parts.length),
            callable = commands[command];

        if (!callable) {
            socket.reply(502)
        } else if (command != 'USER' && command != 'PASS' && socket.user.authorized == false) {
            socket.reply(530)
        } else {
            callable.apply(socket, args)
        }
    });

    // We have a new connection so acknowledge this to the FTP client
    socket.reply(220)
};


module.exports = {
    commands: commands,
    messages: messages,
    backends: backends,
    Server: FTPServer,
    createServer: function(opts) { return new FTPServer(opts); }
};