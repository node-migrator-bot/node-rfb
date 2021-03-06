var assert = require('assert');

var qemu = require('./lib/qemu');
var rfb = require('../');
var png = require('png');
var fs = require('fs');

var Seq = require('seq');
var Hash = require('hashish');
var util = require('util');

exports.rects = function () {
    var port = Math.floor(Math.random() * (Math.pow(2,16) - 10000)) + 10000;
    var q = qemu({ port : port });
    console.log('# gvncviewer :' + (port - 5900));
    
    var to = 'dimensions keys mouse'
        .split(' ')
        .reduce(function (acc, name) {
            acc[name] = setTimeout(function () {
                assert.fail('never reached ' + name);
            }, 60000);
            return acc;
        }, {})
    ;
    
    setTimeout(function () {
        var r = new rfb({ port : port });
        
        r.on('unknownRect', function (rect) {
            var rep = util.inspect(rect);
            assert.fail(
                'unknown rect: '
                + (rep.length > 100 ? rep.slice(0,100) + '...' : rep)
            );
        });
        
        r.dimensions(function (dims) {
            clearTimeout(to.dimensions);
            assert.eql(dims, { width : 720, height : 400 });
        });
        
        r.once('raw', function (rect) {
            assert.eql(rect.width, 720);
            assert.eql(rect.height, 400);
            sendKeys(r);
        });
        
        r.requestRedraw();
    }, 10000);
    
    function sendKeys (r) {
        Seq.ap('xinit'.split(''))
            .seqEach_(function (next, key) {
                r.on('raw', function fn (rect) {
                    var ok = rect.width <= 32 && rect.height <= 32
                        && rect.width > 0 && rect.height > 0;
                    if (!ok) return;
                    r.removeListener('raw', fn);
                    setTimeout(next, 250);
                });
                
                setTimeout(function () {
                    r.sendKeyDown(key.charCodeAt(0));
                    r.sendKeyUp(key.charCodeAt(0));
                }, 50);
            })
            .seq_(function (next) {
                clearTimeout(to.keys);
                
                // send a newline
                r.sendKeyDown(65293);
                r.sendKeyUp(65293);
                
                var toResize = setTimeout(function () {
                    assert.fail('never resized');
                }, 30 * 1000);
                
                r.once('desktopSize', function (dims) {
                    clearTimeout(toResize);
                    
                    assert.equal(dims.width, 640);
                    assert.equal(dims.height, 480);
                    
                    var stack = null;
                    
                    r.on('raw', function (rect) {
                        assert.equal(rect.bitsPerPixel, 32);
                        if (!stack) stack = new png.DynamicPngStack('bgra');
                        
                        stack.push(
                            rect.fb, rect.x, rect.y, rect.width, rect.height
                        );
                    });
                    
                    setTimeout(function () {
                        next.ok(stack);
                    }, 4000);
                });
            })
            .seq_(function (next, stack) {
                var x = 300;
                var y = 300;
                
                var toMouse = setTimeout(function () {
                    assert.fail('mouse never moved');
                }, 15000);
                
                setTimeout(function () {
                    r.once('raw', function (ref) {
                        setTimeout(function () {
                            r.sendPointer(x + 100, y, 0);
                            r.on('raw', function fn (rect) {
                                clearTimeout(toMouse);
                                next.ok(stack);
                            });
                        }, 200);
                    });
                    
                    r.sendPointer(x, y, 0);
                }, 100);
                
                r.sendPointer(x-2, y, 0);
                r.sendPointer(x-1, y, 0);
            })
            .seq(function (stack) {
                clearTimeout(to.mouse);
                
                var data = stack.encodeSync();
                var n = Math.floor(Math.random() * Math.pow(2,32));
                var tmpfile = '/tmp/node-rfb_' + n.toString(16) + '.png';
                fs.writeFile(tmpfile, data, function (err) {
                    if (err) assert.fail(err)
                    else console.log('# Verify the output at ' + tmpfile)
                });
                
                setTimeout(function () {
                    q.stdin.write('quit\n');
                }, 500);
            })
        ;
    }
};
