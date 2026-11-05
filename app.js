// 1) Dán Project URL và anon/public key của Supabase vào đây.
// Không bao giờ đưa service_role key vào mã chạy trên trình duyệt.
const SUPABASE_URL = "https://xpxmxszuoiagvbmpuboc.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhweG14c3p1b2lhZ3ZibXB1Ym9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4NDY0NTcsImV4cCI6MjEwNzQyMjQ1N30.GcH5I89eP1SjPDwolDymd45I7qdPe1k2tyOzFtzA1YA";

const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("DAN_") && !SUPABASE_ANON_KEY.includes("DAN_");
const $ = (id) => document.getElementById(id);
let supabaseClient = null, currentUser = null, profile = null, employees = [], tasks = [], activeFilter = "all", installPrompt = null, intakeStationNo = null, workflowChannel = null, passwordRecoveryPending = false;

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
  // Subscribe before reading the stored session so redirect events are not missed.
  // Defer Supabase queries until this synchronous auth callback has returned.
  supabaseClient.auth.onAuthStateChange((event,session)=>{
    if(event==="PASSWORD_RECOVERY")passwordRecoveryPending=true;
    setTimeout(()=>handleAuthState(event,session),0);
  });
  const {data:{session}}=await supabaseClient.auth.getSession();
  if(session && !currentUser && !passwordRecoveryPending) await enterApp(session.user);
}
async function handleAuthState(event,session){
  if(event==="PASSWORD_RECOVERY"){
    passwordRecoveryPending=true;
    show("authView",true);show("appView",false);show("passwordResetPanel",true);
    msg("passwordResetMessage","Đã xác thực liên kết. Hãy nhập mật khẩu mới.",false);
    return;
  }
  if(session && !currentUser){await enterApp(session.user);return;}
  if(!session){
    if(workflowChannel){await supabaseClient.removeChannel(workflowChannel);workflowChannel=null;}
    currentUser=null;profile=null;intakeStationNo=null;passwordRecoveryPending=false;
    show("appView",false);show("authView",true);show("logoutBtn",false);
  }
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


$("forgotPasswordBtn").addEventListener("click", async () => {
  if (!supabaseClient) return;
  const email = $("email").value.trim();
  if (!email) {
    msg("resetRequestMessage", "Vui lòng nhập email tài khoản vào ô Email trước.");
    $("email").focus();
    return;
  }
  msg("resetRequestMessage", "Đang gửi email khôi phục...", false);
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    console.error(error);
    msg("resetRequestMessage", "Chưa gửi được email khôi phục: " + error.message);
    return;
  }
  msg("resetRequestMessage", "Nếu email tồn tại trong hệ thống, hướng dẫn đặt lại mật khẩu sẽ được gửi tới hộp thư. Vui lòng kiểm tra cả Spam/Junk.", false);
});

$("passwordResetForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!supabaseClient) return;
  const password = $("newPassword").value;
  const confirm = $("confirmNewPassword").value;
  if (password.length < 8) {
    msg("passwordResetMessage", "Mật khẩu cần ít nhất 8 ký tự.");
    return;
  }
  if (password !== confirm) {
    msg("passwordResetMessage", "Hai mật khẩu không khớp.");
    return;
  }
  msg("passwordResetMessage", "Đang cập nhật mật khẩu...", false);
  const { error } = await supabaseClient.auth.updateUser({ password });
  if (error) {
    console.error(error);
    msg("passwordResetMessage", "Không cập nhật được mật khẩu: " + error.message);
    return;
  }
  $("passwordResetForm").reset();
  show("passwordResetPanel", false);
  msg("resetRequestMessage", "Đã đổi mật khẩu thành công. Bạn có thể đăng nhập bằng mật khẩu mới.", false);
  await supabaseClient.auth.signOut();
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
    show("stationAdminSection", currentUser.email === "tu.nguyen@hyundaimiennam.com");
    show("intakeQueueSection", true);
    show("accountAdminSection", currentUser.email === "tu.nguyen@hyundaimiennam.com");
    if (currentUser.email === "tu.nguyen@hyundaimiennam.com") await loadAccountAdmin();
    await loadIntakeQueue();
  }
  show("workOrdersSection", true);
  await loadWorkOrders();
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
  setupWorkflowRealtime();
}
async function loadEmployees(){
  const {data,error}=await supabaseClient.from("profiles").select("id,full_name,email,role,work_role").eq("active",true).order("full_name");
  if(error){msg("taskMessage","Không tải được danh sách nhân viên: "+error.message);return}
  employees=data||[];
  const employeeOptions = employees.map(x=>`<option value="${x.id}">${esc(x.full_name||x.email||"Nhân viên")}</option>`).join("");
  $("assignee").innerHTML='<option value="">Chọn nhân viên</option>'+employeeOptions;
  const stationUser = $("stationUser");
  if (stationUser) stationUser.innerHTML='<option value="">Chọn tài khoản tiếp nhận</option>'+employees.filter(x=>x.work_role==="intake").map(x=>`<option value="${x.id}">${esc(x.full_name||x.email||"Nhân viên")}</option>`).join("");
}


async function loadAccountAdmin() {
  if (currentUser?.email !== "tu.nguyen@hyundaimiennam.com") return;
  const box = $("accountList");
  if (!box) return;
  box.innerHTML = '<div class="empty">Đang tải tài khoản...</div>';
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("id,full_name,email,role,active,work_role,created_at")
    .order("created_at", { ascending: false });
  if (error) {
    box.innerHTML = '<div class="empty">Không tải được danh sách tài khoản.</div>';
    console.error(error);
    return;
  }
  box.innerHTML = (data || []).map(p => {
    const primary = p.email === "tu.nguyen@hyundaimiennam.com";
    const roleOptions = [
      ["unassigned","Chưa phân công"],
      ["intake","Nhân viên tiếp nhận"],
      ["technician","Kỹ thuật viên"],
      ["manager","Quản lý"]
    ].map(([v,label]) => '<option value="' + v + '"' + ((p.work_role || "unassigned")===v?" selected":"") + '>' + label + '</option>').join("");
    return '<article class="intake-card" data-account-id="' + p.id + '">' +
      '<div class="task-top"><strong>' + esc(p.full_name || "Chưa có họ tên") + '</strong><span class="pill ' + (p.active?"done":"todo") + '">' + (p.active?"Đã kích hoạt":"Chờ kích hoạt") + '</span></div>' +
      '<div class="task-meta">' + esc(p.email || "") + '</div>' +
      '<div class="task-meta">Quyền hệ thống: ' + (p.role==="admin"?"Admin":"Nhân viên") + (primary?" · Admin chính":"") + '</div>' +
      (primary ? '<p class="small muted">Tài khoản Admin chính được bảo vệ, không thể thay đổi quyền hoặc khóa.</p>' :
      '<label>Quyền hệ thống<select data-system-role="' + p.id + '"><option value="employee"' + (p.role==="employee"?" selected":"") + '>Nhân viên</option><option value="admin"' + (p.role==="admin"?" selected":"") + '>Admin</option></select></label>' +
      '<label>Vai trò công việc<select data-work-role="' + p.id + '">' + roleOptions + '</select></label>' +
      '<label style="display:flex;align-items:center;gap:8px;margin-top:8px"><input type="checkbox" data-active="' + p.id + '"' + (p.active?" checked":"") + '> Kích hoạt tài khoản</label>' +
      '<button class="btn btn-primary" type="button" data-save-account="' + p.id + '" style="margin-top:10px">Lưu phân quyền</button>') +
      '</article>';
  }).join("") || '<div class="empty">Chưa có tài khoản.</div>';
}

async function saveAccountAdmin(id) {
  if (currentUser?.email !== "tu.nguyen@hyundaimiennam.com") return;
  const card = document.querySelector('[data-account-id="' + id + '"]');
  if (!card) return;
  const role = card.querySelector('[data-system-role]').value;
  const work_role = card.querySelector('[data-work-role]').value;
  const active = card.querySelector('[data-active]').checked;
  const { error } = await supabaseClient.from("profiles")
    .update({ work_role, active, role })
    .eq("id", id)
    .neq("email", "tu.nguyen@hyundaimiennam.com");
  if (error) {
    console.error(error);
    toast("Không lưu được phân quyền. Vui lòng kiểm tra quyền tài khoản.");
    return;
  }
  toast("Đã cập nhật vai trò và trạng thái tài khoản.");
  await loadAccountAdmin();
  await loadEmployees();
}

async function loadIntakeQueue() {
  const box = $("intakeQueue");
  if (!box) return;
  box.innerHTML = '<div class="empty">Đang tải hàng đợi...</div>';
  const { data, error } = await supabaseClient
    .from("vehicle_intakes")
    .select("id,plate_number,customer_name,vehicle_model,document_type,image_path,station_no,received_at,status,plate_confirmed,receiver:profiles!vehicle_intakes_received_by_fkey(full_name)")
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
  const activePlateCounts = data.reduce((counts,item)=>{
    if(item.status!=="closed" && item.plate_number){
      const key=item.plate_number.toUpperCase().replace(/[^A-Z0-9]/g,"");
      counts[key]=(counts[key]||0)+1;
    }
    return counts;
  },{});
  const technicians = employees.filter(x=>x.work_role==="technician");
  const cards = await Promise.all(data.map(async item => {
    const { data: signed } = await supabaseClient.storage.from("vehicle-intakes").createSignedUrl(item.image_path, 300);
    const image = signed?.signedUrl ? '<a href="' + esc(signed.signedUrl) + '" target="_blank" rel="noopener">Mở ảnh phiếu</a>' : "Không tạo được liên kết ảnh";
    const receiver = item.receiver?.full_name || "Nhân viên";
    const plateKey=(item.plate_number||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
    const duplicate=plateKey && item.status!=="closed" && activePlateCounts[plateKey]>1
      ? '<span class="pill late">Biển số trùng: ' + activePlateCounts[plateKey] + ' xe đang xử lý</span>' : "";
    const confirmationWarning=item.plate_confirmed===true ? "" : '<span class="pill late">Chưa ghi nhận xác nhận biển số</span>';
    const technicianChoices=technicians.map(x=>'<label class="technician-option"><input type="checkbox" data-technician-id value="'+x.id+'"><span>'+esc(x.full_name||x.email||"Kỹ thuật viên")+'</span></label>').join("");
    const assignForm=item.status==="closed" ? "" : '<form class="assignment-form" data-assign-intake="' + item.id + '">' +
      '<fieldset class="technician-picker"><legend>Giao cho kỹ thuật viên (có thể chọn nhiều người)</legend><div class="technician-options">' + technicianChoices + '</div></fieldset>' +
      '<label>Hạn hoàn thành (không bắt buộc)<input type="datetime-local" data-assignment-due></label>' +
      '<button class="btn btn-primary" type="submit">Tạo / bổ sung phân công</button><p class="message" data-assign-message aria-live="polite"></p></form>';
    return '<article class="intake-card"><div class="task-top"><strong>' + esc(item.plate_number || "Chưa có biển số") + '</strong><span class="pill ' + (item.status==="new"?"todo":item.status==="assigned"?"doing":"done") + '">' + (item.status==="new"?"Chờ phân công":item.status==="assigned"?"Đang xử lý":"Đã hoàn tất") + '</span></div>' + duplicate + confirmationWarning + '<div class="task-meta"><span>Trạm ' + item.station_no + '</span><span>' + esc(receiver) + '</span><span>' + esc(fmtDate(item.received_at)) + '</span></div><div class="task-meta">' + esc(item.customer_name || "") + ' ' + esc(item.vehicle_model || "") + '</div><div class="task-meta">' + image + '</div>' + assignForm + '</article>';
  }));
  box.innerHTML = cards.join("");
}

async function assignVehicleTechnicians(e){
  e.preventDefault();
  if(profile?.role!=="admin")return;
  const form=e.currentTarget;
  const selected=[...form.querySelectorAll("[data-technician-id]:checked")].map(x=>x.value);
  const message=form.querySelector("[data-assign-message]");
  if(!selected.length){message.textContent="Chọn ít nhất một kỹ thuật viên.";return;}
  const dueValue=form.querySelector("[data-assignment-due]").value;
  const {error}=await supabaseClient.rpc("assign_vehicle_technicians",{
    p_intake_id:form.dataset.assignIntake,
    p_technician_ids:selected,
    p_due_at:dueValue?new Date(dueValue).toISOString():null
  });
  if(error){message.textContent="Chưa giao được việc: "+error.message;return;}
  toast("Đã cập nhật phân công kỹ thuật viên.");
  await Promise.all([loadIntakeQueue(),loadWorkOrders()]);
}

const assignmentStatusText={todo:"Chờ làm",doing:"Đang làm",paused:"Tạm dừng",done:"Hoàn thành"};
async function loadWorkOrders(){
  const box=$("workOrderList");
  if(!box||!supabaseClient||!currentUser)return;
  box.innerHTML='<div class="empty">Đang tải phân công...</div>';
  let query=supabaseClient.from("work_assignments").select(
    "id,work_order_id,technician_id,status,pause_reason,due_at,updated_at,technician:profiles!work_assignments_technician_id_fkey(full_name,email),work_order:work_orders!work_assignments_work_order_id_fkey(id,status,completed_at,completed_by,override_reason,vehicle_intake:vehicle_intakes!work_orders_vehicle_intake_id_fkey(id,plate_number,customer_name,vehicle_model,station_no,received_at))"
  ).order("created_at",{ascending:true});
  if(profile?.role!=="admin")query=query.eq("technician_id",currentUser.id);
  const {data,error}=await query;
  if(error){box.innerHTML='<div class="empty">Không tải được tiến độ phân công.</div>';console.error(error);return;}
  if(!data?.length){box.innerHTML='<div class="empty">Chưa có phân công kỹ thuật viên.</div>';return;}

  const assignmentIds=data.map(x=>x.id);
  const [eventResult,orderEventResult]=await Promise.all([
    supabaseClient.from("work_assignment_events").select("assignment_id,from_status,to_status,pause_reason,created_at,actor:profiles!work_assignment_events_actor_id_fkey(full_name)").in("assignment_id",assignmentIds).order("created_at",{ascending:false}),
    profile?.role==="admin"
      ? supabaseClient.from("work_order_events").select("work_order_id,from_status,to_status,reason,created_at,actor:profiles!work_order_events_actor_id_fkey(full_name)").in("work_order_id",[...new Set(data.map(x=>x.work_order_id))]).order("created_at",{ascending:false})
      : Promise.resolve({data:[],error:null})
  ]);
  if(eventResult.error)console.error(eventResult.error);
  if(orderEventResult.error)console.error(orderEventResult.error);
  const assignmentEvents=eventResult.data||[];
  const orderEvents=orderEventResult.data||[];
  const groups=new Map();
  for(const assignment of data){
    if(!groups.has(assignment.work_order_id))groups.set(assignment.work_order_id,{order:assignment.work_order,assignments:[]});
    groups.get(assignment.work_order_id).assignments.push(assignment);
  }
  box.innerHTML=[...groups.entries()].map(([orderId,group])=>{
    const order=group.order||{};
    const vehicle=order.vehicle_intake||{};
    const orderStatus=order.status==="completed_override"?"Hoàn tất ngoại lệ":order.status==="completed"?"Hoàn thành":"Đang xử lý";
    const assignments=group.assignments.map(a=>{
      const events=assignmentEvents.filter(ev=>ev.assignment_id===a.id).map(ev=>
        '<li>'+esc(ev.actor?.full_name||"Người dùng")+' · '+esc(assignmentStatusText[ev.to_status]||ev.to_status)+' · '+esc(fmtDate(ev.created_at))+(ev.pause_reason?' · '+esc(ev.pause_reason):'')+'</li>'
      ).join("");
      const currentStatus=a.status;
      const controls=profile?.role==="admin"?'<span class="pill '+(currentStatus==="done"?"done":currentStatus==="paused"?"todo":"doing")+'">'+esc(assignmentStatusText[currentStatus])+'</span>':
        order.status==="active"?'<label>Trạng thái<select data-work-status="'+a.id+'" data-current-status="'+a.status+'">'+Object.entries(assignmentStatusText).map(([key,label])=>'<option value="'+key+'"'+(a.status===key?' selected':'')+'>'+label+'</option>').join("")+'</select></label><label>Lý do tạm dừng<input data-pause-reason="'+a.id+'" maxlength="500" value="'+esc(a.status==="paused"?a.pause_reason||"":"")+'" placeholder="Bắt buộc khi chọn tạm dừng"></label>':'<span class="pill done">'+esc(assignmentStatusText[currentStatus])+'</span>';
      return '<article class="assignment-card"><div class="task-top"><strong>'+esc(a.technician?.full_name||a.technician?.email||"Kỹ thuật viên")+'</strong>'+controls+'</div><div class="task-meta">'+(a.due_at?'Hạn: '+esc(fmtDate(a.due_at)):'Chưa đặt hạn')+' · Cập nhật '+esc(fmtDate(a.updated_at))+'</div><details><summary>Lịch sử trạng thái</summary><ol>'+events+'</ol></details></article>';
    }).join("");
    const completionEvents=orderEvents.filter(ev=>ev.work_order_id===orderId).map(ev=>'<li>'+esc(ev.actor?.full_name||"Hệ thống")+' · '+esc(ev.to_status==="completed_override"?"Admin hoàn tất ngoại lệ":ev.to_status==="completed"?"Xe hoàn thành":"Đang xử lý")+' · '+esc(fmtDate(ev.created_at))+(ev.reason?' · '+esc(ev.reason):'')+'</li>').join("");
    const override=profile?.role==="admin"&&order.status==="active"?'<button class="btn btn-light" type="button" data-complete-order="'+orderId+'">Admin xác nhận hoàn thành ngoại lệ</button>':'';
    return '<article class="work-order-card"><div class="task-top"><div><strong>'+esc(vehicle.plate_number||"Xe chưa rõ biển số")+'</strong><div class="task-meta">Trạm '+esc(vehicle.station_no||"")+' · '+esc(vehicle.customer_name||"")+' '+esc(vehicle.vehicle_model||"")+'</div></div><span class="pill '+(order.status==="active"?"doing":"done")+'">'+orderStatus+'</span></div><div class="assignment-list">'+assignments+'</div>'+override+(profile?.role==="admin"?'<details><summary>Lịch sử work order</summary><ol>'+completionEvents+'</ol></details>':'')+'</article>';
  }).join("");
}

async function updateWorkAssignment(e){
  const select=e.target.closest("[data-work-status]");
  if(!select)return;
  const card=select.closest(".assignment-card");
  const reason=card.querySelector("[data-pause-reason]")?.value.trim()||"";
  if(select.value==="paused"&&!reason){toast("Hãy ghi lý do trước khi tạm dừng.");select.value=select.dataset.currentStatus;return;}
  const {error}=await supabaseClient.rpc("set_work_assignment_status",{
    p_assignment_id:select.dataset.workStatus,p_status:select.value,p_pause_reason:reason||null
  });
  if(error){toast("Chưa cập nhật được trạng thái.");console.error(error);await loadWorkOrders();return;}
  toast("Đã cập nhật trạng thái.");
  await Promise.all([loadWorkOrders(),loadIntakeQueue()]);
}

async function completeWorkOrderOverride(e){
  const button=e.target.closest("[data-complete-order]");
  if(!button||profile?.role!=="admin")return;
  const reason=window.prompt("Nhập lý do Admin xác nhận hoàn thành ngoại lệ:")?.trim();
  if(!reason)return;
  const {error}=await supabaseClient.rpc("admin_complete_work_order",{p_work_order_id:button.dataset.completeOrder,p_reason:reason});
  if(error){toast("Chưa xác nhận hoàn thành được.");console.error(error);return;}
  toast("Đã ghi nhận hoàn thành ngoại lệ.");
  await Promise.all([loadWorkOrders(),loadIntakeQueue()]);
}

function setupWorkflowRealtime(){
  if(!supabaseClient||!currentUser)return;
  if(workflowChannel)supabaseClient.removeChannel(workflowChannel);
  workflowChannel=supabaseClient.channel("vehicle-workflow-"+currentUser.id)
    .on("postgres_changes",{event:"*",schema:"public",table:"work_assignments"},()=>loadWorkOrders())
    .on("postgres_changes",{event:"*",schema:"public",table:"work_orders"},()=>{loadWorkOrders();if(profile?.role==="admin")loadIntakeQueue();})
    .on("postgres_changes",{event:"*",schema:"public",table:"vehicle_intakes"},()=>{if(profile?.role==="admin")loadIntakeQueue();})
    .subscribe();
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
    if (!$("intakeDocumentType").value) {
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
  const documentType = $("intakeDocumentType").value;
  if (!file || !plate || !["quotation", "inspection"].includes(documentType) || !$("intakePlateConfirmed").checked) {
    msg("intakeMessage", "Chọn loại phiếu, nhập biển số và xác nhận đã đối chiếu biển số trên ảnh.");
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
    document_type: documentType,
    image_path: path,
    station_no: intakeStationNo,
    received_by: currentUser.id,
    plate_confirmed: $("intakePlateConfirmed").checked
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


$("refreshAccounts")?.addEventListener("click", loadAccountAdmin);
$("accountList")?.addEventListener("click", e => {
  const button = e.target.closest("[data-save-account]");
  if (button) saveAccountAdmin(button.dataset.saveAccount);
});

$("intakeImage")?.addEventListener("change", e => {
  const file = e.target.files?.[0];
  if (!file) return;
  $("intakePlate").value = "";
  $("intakePlateConfirmed").checked = false;
  $("intakeDocumentType").value = "";
  $("intakePreview").src = URL.createObjectURL(file);
  $("intakePreview").classList.remove("hidden");
});
$("intakePlate")?.addEventListener("input", () => { $("intakePlateConfirmed").checked = false; });
$("ocrButton")?.addEventListener("click", runIntakeOcr);
$("intakeForm")?.addEventListener("submit", submitVehicleIntake);
$("stationAdminForm")?.addEventListener("submit", saveIntakeStation);
$("refreshIntakes")?.addEventListener("click", loadIntakeQueue);
$("refreshWorkOrders")?.addEventListener("click", loadWorkOrders);
$("intakeQueue")?.addEventListener("submit", assignVehicleTechnicians);
$("workOrderList")?.addEventListener("change", updateWorkAssignment);
$("workOrderList")?.addEventListener("click", completeWorkOrderOverride);

init();
