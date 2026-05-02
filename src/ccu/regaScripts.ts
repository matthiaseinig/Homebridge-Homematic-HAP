/**
 * ReGa scripts we send to the CCU. Kept out of CcuClient.ts so they are
 * easy to inspect / diff against the upstream hap-homematic versions.
 *
 * Every script emits an XML envelope (delimited by <xml>…</xml>) so we
 * can parse predictable output rather than scraping stdout.
 */

export const DEVICES_SCRIPT = `
string sDeviceId;
string sChannelId;
boolean df = true;
WriteLine("<xml><devices>");
foreach(sDeviceId, root.Devices().EnumIDs()) {
  object oDevice = dom.GetObject(sDeviceId);
  boolean bReady = oDevice.ReadyConfig();
  if (bReady && oDevice.Address().Find(":") < 0) {
    WriteLine("<device>");
    WriteLine("<id>" # sDeviceId # "</id>");
    WriteLine("<address>" # oDevice.Address() # "</address>");
    WriteLine("<name>" # oDevice.Name().UriEncode() # "</name>");
    WriteLine("<type>" # oDevice.HssType() # "</type>");
    WriteLine("<intf>" # oDevice.Interface() # "</intf>");
    WriteLine("<intfName>" # dom.GetObject(oDevice.Interface()).Name() # "</intfName>");
    WriteLine("<channels>");
    foreach(sChannelId, oDevice.Channels().EnumIDs()) {
      object oChannel = dom.GetObject(sChannelId);
      WriteLine("<channel>");
      WriteLine("<id>" # sChannelId # "</id>");
      WriteLine("<address>" # oChannel.Address() # "</address>");
      WriteLine("<name>" # oChannel.Name().UriEncode() # "</name>");
      WriteLine("<type>" # oChannel.HssType() # "</type>");
      WriteLine("<index>" # oChannel.ChnNumber() # "</index>");
      WriteLine("</channel>");
    }
    WriteLine("</channels>");
    WriteLine("</device>");
  }
}
WriteLine("</devices></xml>");
`;

export const VARIABLES_SCRIPT = `
string sVarId;
WriteLine("<xml><variables>");
foreach(sVarId, dom.GetObject(ID_SYSTEM_VARIABLES).EnumUsedIDs()) {
  object oVar = dom.GetObject(sVarId);
  WriteLine("<variable>");
  WriteLine("<id>" # sVarId # "</id>");
  WriteLine("<name>" # oVar.Name().UriEncode() # "</name>");
  WriteLine("<info>" # oVar.DPInfo().UriEncode() # "</info>");
  WriteLine("<valuetype>" # oVar.ValueType() # "</valuetype>");
  WriteLine("<subtype>" # oVar.ValueSubType() # "</subtype>");
  WriteLine("<min>" # oVar.ValueMin() # "</min>");
  WriteLine("<max>" # oVar.ValueMax() # "</max>");
  WriteLine("<unit>" # oVar.ValueUnit().UriEncode() # "</unit>");
  WriteLine("<value>" # oVar.Variable().UriEncode() # "</value>");
  WriteLine("</variable>");
}
WriteLine("</variables></xml>");
`;

export const PROGRAMS_SCRIPT = `
string sProgId;
WriteLine("<xml><programs>");
foreach(sProgId, dom.GetObject(ID_PROGRAMS).EnumIDs()) {
  object oProg = dom.GetObject(sProgId);
  WriteLine("<program>");
  WriteLine("<id>" # sProgId # "</id>");
  WriteLine("<name>" # oProg.Name().UriEncode() # "</name>");
  WriteLine("</program>");
}
WriteLine("</programs></xml>");
`;

export const ROOMS_SCRIPT = `
string sRoomId;
string sChannelId;
WriteLine("<xml><rooms>");
foreach(sRoomId, dom.GetObject(ID_ROOMS).EnumUsedIDs()) {
  object oRoom = dom.GetObject(sRoomId);
  WriteLine("<room>");
  WriteLine("<id>" # sRoomId # "</id>");
  WriteLine("<name>" # oRoom.Name().UriEncode() # "</name>");
  WriteLine("<channels>");
  foreach(sChannelId, oRoom.EnumUsedIDs()) {
    WriteLine("<channelId>" # sChannelId # "</channelId>");
  }
  WriteLine("</channels>");
  WriteLine("</room>");
}
WriteLine("</rooms></xml>");
`;
