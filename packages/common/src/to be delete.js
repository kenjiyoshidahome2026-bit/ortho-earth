import * as d3 from 'd3';
import * as d3Overlay from 'd3-overlay';
import {createAutocomplete} from 'd3-autocomplete';
import * as d3Loader from 'd3-loader';


d3.selection.prototype.editable = function(def, exec) {
    let emode = false;
    return this.attr("contenteditable",true).text(def).on("change",e=>exec(this.text()))
    .on("keydown",e=>emode = (e.which==13))
    .on("keyup", e=>emode && (e.which==13) && exec(this.text()));
}
////-----------------------------------------------------------------------------------------------
////-----------------------------------------------------------------------------------------------
d3.history = async(opts) => {
    opts = Object.assign({db:"s3_history.system", key:"undo", max: 100, initial:[[]], bindKey:false}, opts)
    const {db, key, max, exec, initial, bindKey, trigger} = opts;
    const cache = await d3.cache(db, trigger);
    
    let redo = [], undo = (await cache(key))||initial;
    const history = async value => { //if (!value) return console.error(`history hash error`);
        value = Array.isArray(value)? value: [value];
        JSON.stringify(undo[0]) == JSON.stringify(value) || undo.unshift(value);
        await cache(key, undo.slice(0,max));
    };
    history.val = history.value = () => undo[0];
    history.exec = async() => exec && (await exec(...undo[0]));
    history.forward = async() => {
        redo.length && undo.unshift(redo.shift());
        await history.exec();
        return undo[0];
    }
    history.backward = async() => {
        undo.length > 1 && redo.unshift(undo.shift());
        await history.exec();
        return undo[0];
    }
    history.get = ()=> undo;
    bindKey && exec && d3.select(window).on("keydown", async e => { // ctrl-z / ctrl-shift-z で undo / redo
        if ((e.metaKey || e.ctrlKey) &&(e.which == 90)) { e.preventDefault();
            e.shiftKey? (await history.forward()): (await history.backward());
        }
    });
    return history;

}
////-----------------------------------------------------------------------------------------------
d3.laptime = (() => {
    var start = + new Date(), time = + new Date(), func = console.log;
    return (evnt) => {
        if (!evnt || d3.isFunction(evnt)) { start = + new Date(), func = evnt || func; }
        var now = + new Date();
        var lap = (now - time)/1000, total = (now - start)/1000; 
        evnt && func(`${evnt}: ${lap.toFixed(3)} ${total.toFixed(3)}[sec]`);
        time = now;
    }
})();
