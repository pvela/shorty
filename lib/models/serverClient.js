/**
 * This file is part of Shorty.
 *
 * Shorty is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; version 3 of the License.
 *
 * Shorty is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Shorty.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @category   shorty
 * @license    http://www.gnu.org/licenses/gpl-3.0.txt GPL
 * @copyright  Copyright 2010 Evan Coury (http://www.Evan.pro/)
 * @package    models
 */

var net     = require('net'),
    sys     = require('sys'),
    smpp    = require('./../smpp'),
    pdu     = require('./pdu'),
    sms     = require('./sms');

exports.fromSocket = function(socket, server, connectionEndCallback, callbacks) {
    client = new serverClient(socket, server, connectionEndCallback, callbacks);
    client.init(client.socketDataHandler);
    return client;
}

var serverClient = function(socket, server, closeConnectionServerCallback, callbacks) {
    var self = this;

    self.connection_id = socket.fd;
    self.socket = socket;
    self.sequence_number = 1;
    self.bound = false;

    self.server = server;
    self.config = server.config;

    /*
     *  Implemented callbacks:
     *      - bind_request(system_id, password, system_type): use this to check the
     *              credentials of an incoming connection; return true to allow bind
     */
    self.callbacks = callbacks;

    self.closeConnectionServerCallback = closeConnectionServerCallback;

    self.system_id = "";
    self.password = "";
    self.system_type = "";
    self.interface_version = "";
    self.addr_ton = "";
    self.addr_npi = "";
    self.addr_range = "";

    self.enquire_link_resp_received;

    self.init = function() {
        self.socket.on('data', self.socketDataHandler);
        self.socket.on('end', self.connectionClose);
        self.socket.on('error', self.socketErrorHandler);
    };

    self.socketDataHandler = function(buffer) {
        if (buffer == undefined) {
            return;
        }
        myPdu = pdu.fromBuffer(buffer);
        if ( DEBUG ) { console.log('Incoming PDU : ' + smpp.command_ids[myPdu.command_id]); }
        sys.puts(sys.inspect(buffer));

        switch (myPdu.command_id) {
            case smpp.commands.bind_transceiver:
                // bind_transceiver
                if (DEBUG) { console.log('transceiver attempting bind'); }
                self.bind_transceiver_resp(myPdu);
                break;
            case smpp.commands.enquire_link_resp:
                self.enquire_link_resp_received = new Date().getTime();
                break;
        }
    };

    /*
     *  TODO handle actual timeouts
     */
    self.enquire_link = function() {
        self.sequence_number++;
        if ( DEBUG ) { console.log('sent enquire_link to connection ' + self.connection_id + '; seq: ' + self.sequence_number); }
        myPdu = smpp.enquire_link(self.sequence_number);
        self.sendPdu(myPdu);
        setTimeout(self.check_enquire_link_status, 8 * 1000); // check for enquire_link_resp in 9 seconds
    };

    self.check_enquire_link_status = function() {
        now = new Date.getTime();
        if (now - 10000 >= self.enquire_link_resp_received) {
            console.log("connection timed out");
            self.socket.end();
        }
    }

    /*
     *  TODO figure out what to do if a bind request should be rejected
     */
    self.bind_transceiver_resp = function(myPdu) {
        /*
         *  Parse the PDU body
         */
        payload = myPdu.pdu_body;
        for (i = 0; i < 16; i++ ) {
            if (payload.toString('ascii', i, i+1) == "\0") { break; }
            self.system_id += payload.toString('ascii', i, i+1);
        }

        for (i++; i < 25; i++) {
            if (payload.toString('ascii', i, i+1) == "\0") { break; }
            self.password += payload.toString('ascii', i, i+1);
        }

        for (i++; i < 38; i++) {
            if (payload.toString('ascii', i, i+1) == "\0") { break; }
            self.system_type += payload.toString('ascii', i, i+1);
        }

        i++;
        self.interface_version = payload[i];

        i++;
        self.addr_ton = payload[i];

        i++;
        self.addr_npi = payload[i];

        for (i++; i < payload.length; i++) {
            if (payload.toString('ascii', i, i+1) == "\0") { break; }
            self.addr_range = payload.toString('ascii', i, i+1);
        }

        /*
         *  Ask the callback (if there is one) if the credentials are okay
         */
        if (typeof self.callbacks['bind_request'] == 'function') {
            bindAllowed = self.callbacks['bind_request'](self.system_id, self.password, self.system_type);
        } else {
            bindAllowed = true;
        }

        /*
         *  Create a new PDU with our response
         */
        newPdu = smpp.bind_transceiver_resp(self.sequence_number, self.config.system_id);
        self.sendPdu(newPdu);
        self.bound = true;

        self.socket.setTimeout(self.config.timeout * 1000);
        self.socket.on('timeout', self.enquire_link);
    };

    self.sendPdu = function(myPdu) {
        self.socket.write(myPdu.toBuffer());
    };

    self.connectionClose = function() {
        self.closeConnectionServerCallback(self.connection_id);
    };

    self.socketErrorHandler = function(e) {
        switch(e.errno) {
            // Broken pipe
            case 32:
                console.log('unexpected client disconnect');
                self.socket.end();
                break;
            default:
                console.log('unknown socket error; closing socket');
                self.socket.end();
                break;
        }

    };
}