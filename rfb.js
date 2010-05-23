// rfb client module
// http://www.realvnc.com/docs/rfbproto.pdf

var sys = require('sys');
var net = require('net');
var fs = require('fs');
var Buffer = require('buffer').Buffer;
var BufferList = require('bufferlist').BufferList;
var Binary = require('bufferlist/binary').Binary;
var Png = require('png').Png;

var clientMsgTypes = {
    setPixelFormat : 0,
    setEncoding : 2,
    fbUpdate : 3,
    keyEvent : 4,
    pointerEvent : 5,
    cutText : 6
};

var serverMsgTypes = {
    fbUpdate : 0,
    setColorMap : 1,
    bell: 2,
    cutText: 3
};

function Word8(x) {
    return String.fromCharCode(x);
}

function Word16be(x) {
    return String.fromCharCode((x>>8)&0xFF) + String.fromCharCode(x&0xFF);
}

exports.RFB = RFB;
function RFB(opts) {
    var rfb = this;
    if (typeof(opts) == 'undefined') opts = {};
    
    rfb.host = opts.host || 'localhost';
    rfb.port = opts.port || 5900;
    rfb.shared = opts.shared || false;
    rfb.securityType = opts.securityType || 'none';
    
    var stream = new net.Stream;

    var bufferList = new BufferList;
    var parser = new Parser(rfb, bufferList);

    stream.addListener('data', function (data) {
        bufferList.push(data);
    })
    
    stream.setNoDelay();
    stream.connect(rfb.port, rfb.host);
    
    this.send = function (msg) {
        stream.write(msg, 'binary');
        return this;
    }
    
    this.end = function () {
        stream.end();
        return this;
    };

    var msgBuf = [];
    this.bufferMsg = function (msg) {
        msgBuf.push(msg);
        return this;
    }

    this.sendBuffer = function () {
        var msg = msgBuf.join('');
        msgBuf = [];
        return this.send(msg);
    }
}

function Parser (rfb, bufferList) {
    Binary(bufferList)
        // version handshake
        .getBuffer('prelude',12)
        .tap(function (vars) {
            var m = vars.prelude.toString().match(/^RFB (\d{3}\.\d{3})/);
            if (!m) {
                sys.log("Couldn't parse version handshake: " + vars.prelude);
                this.clear();
            }
            else {
                var version = Number(m[1]);
                if (version < 3.008) {
                    sys.log('Remote version ' + version + ' < 3.008');
                    this.clear();
                }
                rfb.send('RFB 003.008\n');
            }
        })
        .flush()
        // security handshake
        .getWord8('secLen')
        .when('secLen', 0, function (vars) {
            this
                .clear()
                .getWord8('msgLen')
                .getBuffer('msg','msgLen')
                .tap(function (vars) {
                    sys.log(
                        'Server returned error in security handshake: '
                        + vars.msg.toString()
                    );
                })
            ;
        })
        .getBuffer('secTypes','secLen')
        .tap(function (vars) {
            // vars.secTypes is a Buffer object; make an array
            var secTypes = [];
            for (var i = 0; i < vars.secTypes.length; i++) {
                secTypes.push(vars.secTypes[i]);
            }
            
            var secNum = {
                'none' : 1
            }[rfb.securityType];
            
            if (secTypes.indexOf(secNum) < 0) {
                sys.log('Security type ' + rfb.securityType + ' not supported');
                this.clear();
            }
            rfb.send(Word8(secNum));
        })
        .flush()
        .getWord32be('secRes')
        .unless('secRes', 0, function (vars) {
            sys.log('0 for some reason!');
            this
                .tap(function (vars) { sys.p(vars.secRes) })
                .clear()
                .getWord8('msgLen')
                .tap(function (vars) { sys.p(vars.msgLen) })
                .getBuffer('msg')
                .tap(function (vars) {
                    sys.log('Security handshake failed with message: '
                        + vars.msg.toString()
                    );
                });
            ;
        })
        .flush()
        // init handshake
        .tap(function (vars) {
            rfb.send(Word8(rfb.shared));
        })
        .getWord16be('fbWidth')
        .getWord16be('fbHeight')
        .getWord8('pfBitsPerPixel') // pf is pixelFormat
        .getWord8('pfDepth')
        .getWord8('pfBigEndianFlag')
        .getWord8('pfTrueColorFlag')
        .getWord16be('pfRedMax')
        .getWord16be('pfGreenMax')
        .getWord16be('pfBlueMax')
        .getWord8('pfRedShift')
        .getWord8('pfGreenShift')
        .getWord8('pfBlueShift')
        .skip(3)
        .getWord32be('nameLength')
        .getBuffer('nameString', 'nameLength')
        .tap(function (vars) {
            rfb.bufferMsg(Word8(clientMsgTypes.fbUpdate));
            rfb.bufferMsg(Word8(1));
            rfb.bufferMsg(Word16be(0));
            rfb.bufferMsg(Word16be(0));
            rfb.bufferMsg(Word16be(vars.fbWidth));
            rfb.bufferMsg(Word16be(vars.fbHeight));
            rfb.sendBuffer();
        })
        .flush()
        .forever(function (vars) {
            this
                .getWord8('serverMsgType')
                .tap(function (vars) {
                    sys.log('serverMsgType: ' + vars.serverMsgType);
                })
                .when('serverMsgType', serverMsgTypes.fbUpdate, function (vars) {
                    this
                        .skip(1)
                        .getWord16be('nRects')
                        .tap(function (vars) {
                            sys.log('nRects: ' + vars.nRects)
                        })
                        .repeat('nRects', function (vars, i) {
                            sys.log('rawr');
                            this
                                .getWord16be('x')
                                .getWord16be('y')
                                .getWord16be('w')
                                .getWord16be('h')
                                .getWord32be('encodingType')
                                .tap(function (vars) {
                                    sys.log([vars.x, vars.y, vars.w, vars.h]);
                                    vars.fbSize = vars.w*vars.h*vars.pfBitsPerPixel/8;
                                })
                                .getBuffer('fb', 'fbSize')
                                .tap(function (vars) {
                                    /* this prepares rgba rect files for rfb test server

                                    if (vars.counter === undefined) vars.counter = 0;
                                        
                                    var fileName = (vars.counter++).toString() + '-rgba-' +
                                        vars.x + '-' + vars.y + '-' + vars.w + '-' +
                                        vars.h + '.dat';
                                    fs.writeFileSync(fileName, vars.fb.toString('binary'),
                                        'binary');
                                    sys.log(fileName + ' written');
                                    */

                                    var fileName = 'fb' + i + '.png';
                                    var png = new Png(vars.fb, vars.w, vars.h);
                                    fs.writeFileSync(fileName, png.encode(), 'binary');
                                    sys.log(fileName + ' written');
                                })
                                .flush()
                            ;
                        })
                    ;
                })
                /*
                .when('serverMsgType', serverMsgTypes.setColorMap, function (vars) {
                    this
                        .tap(function (vars) { sys.log('setColorMap not implemented yet') })
                })
                .when('serverMsgType', serverMsgTypes.bell, function (vars) {
                    this
                        .tap(function (vars) { sys.log('bell not implemented yet') })
                })
                .when('serverMsgType', serverMsgTypes.cutText, function (vars) {
                    this
                        .tap(function (vars) { sys.log('cutText not implemented yet') })
                })
                */
            ;
        })
    ;
}

