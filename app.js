// 1) Dán Project URL và anon/public key của Supabase vào đây.
// Không bao giờ đưa service_role key vào mã chạy trên trình duyệt.
const SUPABASE_URL = "https://xpxmxszuoiagvbmpuboc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhweG14c3p1b2lhZ3ZibXB1Ym9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4NDY0NTcsImV4cCI6MjEwNzQyMjQ1N30.GcH5I89eP1SjPDwolDymd45I7qdPe1k2tyOzFtzA1YA";

const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("DAN_") && !SUPABASE_ANON_KEY.includes("DAN_");
const $ = (id) => document.getElementById(id);
let supabaseClient = null, currentUser = null, profile = null, employees = [], tasks = [], activeFilter = "all", installPrompt = null, intakeStationNo = null;

const statusText = {todo:"Chưa làm", doing:"Đang làm", done:"Hoàn thành"};
function isLate(t){return t.status!=="done" && new Date(t.due_at).getTime()<Date.now()}
function fmtDate(v){return new Intl.DateTimeFormat("vi-VN",{dateStyle:"short",timeStyle:"short"}).format(new Date(v))}
function esc(v=""){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function toast(msg){const el=$("toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2800)}
function show(el,on=true){$(el).classList.toggle("hidden",!on)}
function msg(id,text,isError=true){$(id).textContent=text;$(id).style.color=isError?"#d92d3a":"#16845b"}

async function init(){
  if("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(()=>{});
  if(!configured){show("configNotice");return}
  supabaseClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY);
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(session) await enterApp(session.user);
  supabaseClient.auth.onAuthStateChange(async (_event,session)=>{if(session && !currentUser) await enterApp(session.user); else if(!session){currentUser=null;profile=null;show("appView",false);show("authView",true);show("logoutBtn",false)}});
}
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!supabaseClient) return;

  msg("authMessage", "Đang đăng nhập...", false);
  const { error } = await supabaseClient.auth.signInWithPassword({
    email: $("email").value.trim(),
    password: $("password").value
  });

  if (error) {
    msg("authMessage", "Không đăng nhập được. Vui lòng kiểm tra email, mật khẩu hoặc liên hệ quản lý.");
  }
});

$("signupForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!supabaseClient) return;

  const full_name = $("signupName").value.trim();
  const email = $("signupEmail").value.trim();
  const password = $("signupPassword").value;

  if (!full_name) {
    msg("signupMessage", "Vui lòng nhập họ và tên.");
    return;
  }

  msg("signupMessage", "Đang tạo tài khoản...", false);

  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { full_name } }
  });

  if (error) {
    msg("signupMessage", "Đăng ký chưa thành công: " + error.message);
    return;
  }

  // Nếu dự án bật xác nhận email tự động tạo session, thoát session ngay.
  // Nhân viên vẫn phải chờ quản lý kích hoạt hồ sơ trước khi sử dụng.
  if (data.session) {
    await supabaseClient.auth.signOut();
  }

  $("signupForm").reset();
  msg("signupMessage", "Đăng ký thành công. Vui lòng chờ quản lý kích hoạt tài khoản.", false);
});

$("logoutBtn").addEventListener("click",async()=>{await supabaseClient.auth.signOut();currentUser=null;profile=null;show("appView",false);show("authView",true);show("logoutBtn",false)});
async function enterApp(user){
  currentUser=user;
  const {data,error}=await supabaseClient.from("profiles").select("id,full_name,role,active").eq("id",user.id).single();
  if(error||!data||!data.active){await supabaseClient.auth.signOut();msg("authMessage","Tài khoản chưa được kích hoạt. Vui lòng liên hệ quản lý.");return}
  profile=data; show("authView",false);show("appView",true);show("logoutBtn",true);
  $("welcomeTitle").textContent="Xin chào, "+(profile.full_name||user.email.split("@")[0]);
  $("roleLabel").textContent=profile.role==="admin"?"QUẢN LÝ":"NHÂN VIÊN";
  show("createSection",profile.role==="admin");
  $("listHeading").textContent=profile.role==="admin"?"Tất cả công việc":"Công việc của tôi";
  if(profile.role==="admin") {
    await loadEmployees();
    show("stationAdminSection", true);
    show("intakeQueueSection", true);
    await loadIntakeQueue();
  }
  const { data: stationData } = await supabaseClient
    .from("intake_station_users")
    .select("station_no")
    .eq("profile_id", currentUser.id)
    .maybeSingle();
  intakeStationNo = stationData?.station_no ?? null;
  if (intakeStationNo) {
    show("intakeSection", true);
    $("intakeStationLabel").textContent = "Tài khoản được gán Trạm " + intakeStationNo;
  }
  await loadTasks();
}
async function loadEmployees(){
  const {data,error}=await supabaseClient.from("profiles").select("id,full_name,email").eq("active",true).order("full_name");
  if(error){msg("taskMessage","Không tải được danh sách nhân viên: "+error.message);return}
  employees=data||[];
  $("assignee").innerHTML='<option value="">Chọn nhân viên</option>'+employees.filter(x=>x.id!==currentUser.id || true).map(x=>`<option value="${x.id}">${esc(x.full_name||x.email||"Nhân viên")}</option>`).join("");
}

async function loadIntakeQueue() {
  const box = $("intakeQueue");
  if (!box) return;
  box.innerHTML = '<div class="empty">Đang tải hàng đợi...</div>';
  const { data, error } = await supabaseClient
    .from("vehicle_intakes")
    .select("id,plate_number,customer_name,vehicle_model,document_type,image_path,station_no,received_at,status,receiver:profiles!vehicle_intakes_received_by_fkey(full_name)")
    .order("received_at", { ascending: true });
  if (error) {
    box.innerHTML = '<div class="empty">Không tải được hàng đợi tiếp nhận. Vui lòng kiểm tra quyền truy cập.</div>';
    console.error(error);
    return;
  }
  if (!data?.length) {
    box.innerHTML = '<div class="empty">Chưa có xe nào được tiếp nhận.</div>';
    return;
  }
  const cards = await Promise.all(data.map(async item => {
    const { data: signed } = await supabaseClient.storage.from("vehicle-intakes").createSignedUrl(item.image_path, 300);
    const image = signed?.signedUrl ? '<a href="' + signed.signedUrl + '" target="_blank" rel="noopener">Mở ảnh phiếu</a>' : "Không tạo được liên kết ảnh";
    const receiver = item.receiver?.full_name || "Nhân viên";
    return '<article class="intake-card"><div class="task-top"><strong>' + esc(item.plate_number || "Chưa có biển số") + '</strong><span class="pill ' + (item.status==="new"?"todo":"doing") + '">' + (item.status==="new"?"Chờ phân công":item.status==="assigned"?"Đã phân công":"Đã đóng") + '</span></div><div class="task-meta"><span>Trạm ' + item.station_no + '</span><span>' + esc(receiver) + '</span><span>' + esc(fmtDate(item.received_at)) + '</span></div><div class="task-meta">' + esc(item.customer_name || "") + ' ' + esc(item.vehicle_model || "") + '</div><div class="task-meta">' + image + '</div></article>';
  }));
  box.innerHTML = cards.join("");
}

async function runIntakeOcr() {
  const file = $("intakeImage").files?.[0];
  if (!file) {
    msg("ocrMessage", "Vui lòng chụp hoặc chọn ảnh phiếu trước.");
    return;
  }
  if (!window.Tesseract) {
    msg("ocrMessage", "Chưa tải được bộ nhận diện. Bạn có thể nhập biển số thủ công.");
    return;
  }
  msg("ocrMessage", "Đang đọc ảnh. Với chữ viết tay, kết quả có thể không chính xác...", false);
  try {
    const result = await window.Tesseract.recognize(file, "eng");
    const textValue = result?.data?.text || "";
    const compact = textValue.toUpperCase().replace(/\s+/g, " ");
    const plateMatch = compact.match(/\b\d{2}\s?[A-Z]{1,2}\s*[- ]?\s*\d{3}\s*\.?\s*\d{2}\b/) ||
      compact.match(/\b\d{2}\s?[A-Z]{1,2}\s*[- ]?\s*\d{4,5}\b/);
    if (plateMatch && !$("intakePlate").value.trim()) {
      $("intakePlate").value = plateMatch[0].replace(/\s+/g, "").replace(/^(\d{2}[A-Z]{1,2})/, "$1-");
    }
    const normalized = textValue.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
    if ($("intakeDocumentType").value === "unknown") {
      if (normalized.includes("BAO GIA")) $("intakeDocumentType").value = "quotation";
      else if (normalized.includes("PHIEU KIEM TRA")) $("intakeDocumentType").value = "inspection";
    }
    msg("ocrMessage", plateMatch ? "Đã tìm thấy gợi ý biển số. Vui lòng kiểm tra và sửa lại nếu sai." : "Chưa đọc rõ biển số. Vui lòng nhập thủ công.", false);
  } catch (error) {
    console.error(error);
    msg("ocrMessage", "Không đọc được ảnh này. Vui lòng nhập biển số thủ công.");
  }
}

async function submitVehicleIntake(e) {
  e.preventDefault();
  if (!intakeStationNo) {
    msg("intakeMessage", "Tài khoản này chưa được quản lý gán trạm tiếp nhận.");
    return;
  }
  const file = $("intakeImage").files?.[0];
  const plate = $("intakePlate").value.trim().toUpperCase();
  if (!file || !plate) {
    msg("intakeMessage", "Vui lòng chọn một ảnh phiếu và xác nhận biển số.");
    return;
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) {
    msg("intakeMessage", "Ảnh phải là JPG, PNG hoặc WEBP và không vượt quá 8 MB.");
    return;
  }
  const extension = file.type === "image/png" ? "png" : file.type === "image/webp" ? "webp" : "jpg";
  const path = currentUser.id + "/" + Date.now() + "_" + crypto.randomUUID() + "." + extension;
  msg("intakeMessage", "Đang tải ảnh và lưu hồ sơ...", false);
  const { error: uploadError } = await supabaseClient.storage.from("vehicle-intakes")
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) {
    console.error(uploadError);
    msg("intakeMessage", "Không tải được ảnh. Vui lòng thử lại.");
    return;
  }
  const { error } = await supabaseClient.from("vehicle_intakes").insert({
    plate_number: plate,
    customer_name: $("intakeCustomer").value.trim() || null,
    vehicle_model: $("intakeModel").value.trim() || null,
    chassis_number: $("intakeChassis").value.trim() || null,
    document_type: $("intakeDocumentType").value,
    image_path: path,
    station_no: intakeStationNo,
    received_by: currentUser.id
  });
  if (error) {
    await supabaseClient.storage.from("vehicle-intakes").remove([path]);
    console.error(error);
    msg("intakeMessage", "Ảnh đã tải lên nhưng chưa lưu được hồ sơ. Vui lòng thử lại.");
    return;
  }
  $("intakeForm").reset();
  $("intakePreview").classList.add("hidden");
  msg("intakeMessage", "Đã tiếp nhận xe thành công.", false);
  toast("Đã gửi hồ sơ tiếp nhận.");
  if (profile.role === "admin") await loadIntakeQueue();
}

async function saveIntakeStation(e) {
  e.preventDefault();
  if (profile?.role !== "admin") return;
  const profile_id = $("stationUser").value;
  const station_no = Number($("stationNo").value);
  if (!profile_id) return;
  const { error } = await supabaseClient.from("intake_station_users")
    .upsert({ profile_id, station_no }, { onConflict: "profile_id" });
  if (error) {
    console.error(error);
    msg("stationAdminMessage", "Không lưu được. Mỗi trạm chỉ được gán cho một tài khoản.");
    return;
  }
  msg("stationAdminMessage", "Đã gán tài khoản vào Trạm " + station_no + ".", false);
  if (profile_id === currentUser.id) {
    intakeStationNo = station_no;
    show("intakeSection", true);
    $("intakeStationLabel").textContent = "Tài khoản được gán Trạm " + station_no;
  }
}

async function loadTasks(){
  $("taskList").innerHTML='<div class="empty">Đang tải công việc...</div>';
  let q=supabaseClient.from("tasks").select("id,title,notes,status,due_at,priority,created_at,assignee_id,created_by,assignee:profiles!tasks_assignee_id_fkey(full_name,email),creator:profiles!tasks_created_by_fkey(full_name)").order("due_at",{ascending:true});
  if(profile.role!=="admin")q=q.eq("assignee_id",currentUser.id);
  const {data,error}=await q;
  if(error){$("taskList").innerHTML='<div class="empty">Không tải được dữ liệu. Kiểm tra cấu hình cơ sở dữ liệu.</div>';console.error(error);return}
  tasks=data||[];renderTasks();
}
function renderTasks(){
  const todo=tasks.filter(t=>t.status==="todo").length,doing=tasks.filter(t=>t.status==="doing").length,late=tasks.filter(isLate).length;
  $("countTodo").textContent=todo;$("countDoing").textContent=doing;$("countLate").textContent=late;
  const filtered=tasks.filter(t=>activeFilter==="all"||(activeFilter==="late"?isLate(t):t.status===activeFilter));
  if(!filtered.length){$("taskList").innerHTML='<div class="empty">Chưa có công việc ở mục này.</div>';return}
  $("taskList").innerHTML=filtered.map(t=>{
    const lateNow=isLate(t), who=t.assignee?.full_name||t.assignee?.email||"Nhân viên";
    return `<article class="task-card"><div class="task-top"><div class="task-title">${esc(t.title)}</div><span class="pill ${lateNow?"late":t.status}">${lateNow?"Quá hạn":statusText[t.status]}</span></div>
      <div class="task-meta">${profile.role==="admin"?`<span>👤 ${esc(who)}</span>`:""}<span>🗓 Hạn: ${esc(fmtDate(t.due_at))}</span>${t.priority==="high"?'<span class="pill priority">Ưu tiên cao</span>':""}</div>
      ${t.notes?`<div class="task-notes">${esc(t.notes)}</div>`:""}
      ${profile.role==="admin"?`<div class="task-meta">Người giao: ${esc(t.creator?.full_name||"Quản lý")}</div>`:""}
      <div class="task-actions"><label style="display:flex;align-items:center;gap:8px">Cập nhật:<select data-status-id="${t.id}" ${t.status==="done"&&profile.role!=="admin"?"":" "}>${Object.entries(statusText).map(([k,v])=>`<option value="${k}" ${t.status===k?"selected":""}>${v}</option>`).join("")}</select></label></div></article>`
  }).join("");
  document.querySelectorAll("[data-status-id]").forEach(el=>el.addEventListener("change",()=>updateStatus(el.dataset.statusId,el.value)));
}
async function updateStatus(id,status){
  const {error}=await supabaseClient.rpc("update_task_status",{p_task_id:id,p_status:status});
  if(error){toast("Chưa cập nhật được trạng thái.");console.error(error);await loadTasks();return}
  toast("Đã cập nhật trạng thái.");await loadTasks();
}
document.querySelectorAll(".filter").forEach(b=>b.addEventListener("click",()=>{activeFilter=b.dataset.filter;document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x===b));renderTasks()}));
$("refreshBtn").addEventListener("click",loadTasks);
$("taskForm").addEventListener("submit",async e=>{
  e.preventDefault();if(profile?.role!=="admin")return;
  const title=$("taskTitle").value.trim(),assignee_id=$("assignee").value,due=$("dueAt").value;
  if(!title||!assignee_id||!due){msg("taskMessage","Vui lòng nhập đủ tên việc, người thực hiện và hạn hoàn thành.");return}
  const {error}=await supabaseClient.from("tasks").insert({title,assignee_id,due_at:new Date(due).toISOString(),priority:$("priority").value,notes:$("taskNotes").value.trim()||null,created_by:currentUser.id});
  if(error){msg("taskMessage","Giao việc chưa thành công. Kiểm tra dữ liệu và quyền truy cập.");console.error(error);return}
  $("taskForm").reset();msg("taskMessage","Đã giao việc thành công.",false);toast("Đã giao việc.");await loadTasks();
});
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;show("installBtn")});
$("installBtn").addEventListener("click",async()=>{if(!installPrompt){toast("Trên iPhone: mở nút Chia sẻ rồi chọn Thêm vào MH chính.");return}installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;show("installBtn",false)});

$("intakeImage")?.addEventListener("change", e => {
  const file = e.target.files?.[0];
  if (!file) return;
  $("intakePreview").src = URL.createObjectURL(file);
  $("intakePreview").classList.remove("hidden");
});
$("ocrButton")?.addEventListener("click", runIntakeOcr);
$("intakeForm")?.addEventListener("submit", submitVehicleIntake);
$("stationAdminForm")?.addEventListener("submit", saveIntakeStation);
$("refreshIntakes")?.addEventListener("click", loadIntakeQueue);

init();
