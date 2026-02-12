const { checkLayout } = require("./build/drawio.js");
checkLayout("./example-batch-test.drawio").then(w => {
  w.forEach(x => {
    console.log("[" + x.severity.toUpperCase() + "] " + x.type);
    console.log("  " + x.message);
    if (x.suggestion) console.log("  -> " + x.suggestion);
    console.log();
  });
}).catch(e => console.error(e));
