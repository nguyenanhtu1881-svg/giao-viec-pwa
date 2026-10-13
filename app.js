// 1) Dán Project URL và anon/public key của Supabase vào đây.
// Không bao giờ đưa service_role key vào mã chạy trên trình duyệt.
const SUPABASE_URL = "https://sb_publishable_OhG0GZFLD7SsxWa-K5qPdQ_DHnZQy75";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhweG14c3p1b2lhZ3ZibXB1Ym9jIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE4NDY0NTcsImV4cCI6MjEwNzQyMjQ1N30.GcH5I89eP1SjPDwolDymd45I7qdPe1k2tyOzFtzA1YA";

const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("DAN_") && !SUPABASE_ANON_KEY.includes("DAN_");
const $ = (id) => document.getElementById(id);
let supabaseClient = null, currentUser = null, profile = null, employees = [], tasks = [], activeFilter = "all", installPrompt = null;

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
$("loginForm").addEventListener("submit",async e=>{
  e.preventDefault(); if(!supabaseClient)return;
  msg("authMessage","Đang đăng nhập...",false);
  const {error}=await supabaseClient.auth.signInWithPassword({email:$("email").value.trim(),password:$("password").value});
  if(error)msg("authMessage","Không đăng nhập được. Vui lòng kiểm tra email, mật khẩu hoặc liên hệ quản lý.");
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
  if(profile.role==="admin")await loadEmployees();
  await loadTasks();
}
async function loadEmployees(){
  const {data,error}=await supabaseClient.from("profiles").select("id,full_name,email").eq("active",true).order("full_name");
  if(error){msg("taskMessage","Không tải được danh sách nhân viên: "+error.message);return}
  employees=data||[];
  $("assignee").innerHTML='<option value="">Chọn nhân viên</option>'+employees.filter(x=>x.id!==currentUser.id || true).map(x=>`<option value="${x.id}">${esc(x.full_name||x.email||"Nhân viên")}</option>`).join("");
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
init();
